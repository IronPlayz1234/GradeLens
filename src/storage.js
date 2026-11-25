importScripts('core/grades.js', 'core/cache.js', 'repository.js', 'appearance-registry.js');

const app = globalThis.MBGC;
const origin = 'https://uia.managebac.com';
let pending = Promise.resolve();
const tabLeases = new Map();

chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  if (reason !== 'update' || !previousVersion) return;
  const key = 'mbgc:preferences';
  void enqueue(async () => {
    const result = await chrome.storage.local.get(key);
    const preferences = result[key] ?? {};
    if (!Object.hasOwn(preferences, 'welcomeSeen')) return chrome.storage.local.set({ [key]: { ...preferences, welcomeSeen: true } });
  }).catch(() => {});
});

function enqueue(operation) {
  const work = pending.then(operation);
  pending = work.catch(() => {});
  return work;
}

function cancelTabLease(tabId) {
  const active = tabLeases.get(tabId);
  if (!active) return;
  tabLeases.delete(tabId);
  void enqueue(async () => {
    const stored = (await chrome.storage.session.get(active.leaseKey))[active.leaseKey];
    if (stored?.token === active.token) {
      await chrome.storage.session.remove([active.leaseKey, active.refreshKey]);
    }
  }).catch(() => {});
}

chrome.tabs.onRemoved.addListener(cancelTabLease);
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === 'loading') cancelTabLease(id);
});

async function notify(account, originTab) {
  const tabs = await chrome.tabs.query({ url: [origin + '/student', origin + '/student/*'] });
  await Promise.allSettled(tabs.filter((tab) => tab.id !== originTab).map((tab) =>
    chrome.tabs.sendMessage(tab.id, { type: 'mbgc:cache-updated', account })));
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const student = (sender.origin == null || sender.origin === origin) && sender.frameId === 0 &&
    /^https:\/\/uia\.managebac\.com\/student(?:[/?#]|$)/.test(sender.url ?? '');
  if (student && sender.id === chrome.runtime.id && message?.type === 'mbgc:native-paint-css' && sender.documentId && sender.tab?.id != null) {
    chrome.scripting.insertCSS({
      files: ['src/ui/native-paint.css'],
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      origin: 'USER'
    }).then(() => respond(true), () => respond(false));
    return true;
  }
  if (sender.id === chrome.runtime.id && message?.type === 'mbgc:preferences' &&
    (student || sender.url === chrome.runtime.getURL('popup.html'))) {
    enqueue(async () => {
      const key = app.preferencesKey;
      const stored = (await chrome.storage.local.get(key))[key];
      const next = app.patchSettings(stored, message);
      if (JSON.stringify(stored) !== JSON.stringify(next)) await chrome.storage.local.set({ [key]: next });
      const before = app.normalizeSettings(stored);
      if (before.appearance !== next.appearance || before.enabled !== next.enabled) {
        await app.refreshAppearancePrimer().catch(() => {});
      }
      return next;
    }).then((value) => respond({ value }), () => respond({ error: 'Preferences could not be saved.' }));
    return true;
  }
  if (sender.id !== chrome.runtime.id || (sender.origin != null && sender.origin !== origin) || sender.frameId !== 0 || !/^https:\/\/uia\.managebac\.com\/student(?:[/?#]|$)/.test(sender.url ?? '') ||
    typeof message !== 'object' || !message?.type?.startsWith('mbgc:')) return;
  const work = enqueue(async () => {
    const account = /^(?:\d+|profile-[a-f0-9]{64})$/.test(message.account ?? '') ? message.account : null;
    if (!account) throw new Error('A student account was not identified.');
    const key = `mbgc:cache:${new URL(origin).host}:${account}`;
    const overrideKey = `mbgc:overrides:${new URL(origin).host}:${account}`;
    if (['mbgc:get', 'mbgc:clear', 'mbgc:scan'].includes(message.type)) {
      const state = await loadAccount(account);
      if (message.type === 'mbgc:clear') {
        const cleared = { ...app.freshCache(), clearedAt: Date.now() };
        await saveAccount(account, cleared, [], true);
        state.cache = cleared;
        state.journal = [];
        await chrome.storage.local.remove(overrideKey);
        void notify(account, sender.tab?.id).catch(() => {});
        return cleared;
      }
      if (message.type === 'mbgc:scan' &&
        await commitScans(account, state, message.snapshots, message.checks ?? [])) {
        void notify(account, sender.tab?.id).catch(() => {});
      }
      return replyFor(state, message.since, message.epoch);
    }
    if (message.type === 'mbgc:lease' || message.type === 'mbgc:release') {
      const leaseKey = key + ':lease';
      const refreshKey = key + ':refresh';
      const stored = await chrome.storage.session.get([leaseKey, refreshKey]);
      const lease = stored[leaseKey];
      if (message.type === 'mbgc:release') {
        if (lease?.token === message.token && lease.owner === sender.tab?.id) {
          if (tabLeases.get(lease.owner)?.token === lease.token) tabLeases.delete(lease.owner);
          await chrome.storage.session.remove(message.aborted ? [leaseKey, refreshKey] : leaseKey);
        }
        return null;
      }
      const now = Date.now();
      const replacedDocument = lease?.owner === sender.tab?.id && lease?.documentId && sender.documentId &&
        lease.documentId !== sender.documentId;
      if (!replacedDocument && lease?.until > now) return null;
      if (!replacedDocument && now - (stored[refreshKey] ?? 0) < (message.manual || message.hasNewSources ? 3000 : message.interval)) return null;
      const token = crypto.randomUUID();
      const owner = sender.tab?.id;
      await chrome.storage.session.set({ [refreshKey]: now,
        [leaseKey]: { token, owner, documentId: sender.documentId, until: now + 95000 } });
      tabLeases.set(owner, { token, leaseKey, refreshKey });
      return token;
    }
    throw new Error('Unrecognized storage operation.');
  });
  work.then((value) => respond({ value }), (error) => respond({ error: error.message }));
  return true;
});
