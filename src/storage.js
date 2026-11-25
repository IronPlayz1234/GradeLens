importScripts('core/grades.js', 'core/cache.js');

const app = globalThis.MBGC;
const origin = 'https://uia.managebac.com';
let pending = Promise.resolve();

async function notify(account, originTab) {
  const tabs = await chrome.tabs.query({ url: [origin + '/student', origin + '/student/*'] });
  await Promise.allSettled(tabs.filter((tab) => tab.id !== originTab).map((tab) =>
    chrome.tabs.sendMessage(tab.id, { type: 'mbgc:cache-updated', account })));
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || (sender.origin != null && sender.origin !== origin) || sender.frameId !== 0 || !/^https:\/\/uia\.managebac\.com\/student(?:[/?#]|$)/.test(sender.url ?? '') ||
    typeof message !== 'object' || !message?.type?.startsWith('mbgc:')) return;
  const work = pending.then(async () => {
    const account = /^\d+$/.test(message.account ?? '') ? message.account : null;
    if (!account) throw new Error('A student account was not identified.');
    const key = `mbgc:cache:${new URL(origin).host}:${account}`;
    const overrideKey = `mbgc:overrides:${new URL(origin).host}:${account}`;
    if (message.type === 'mbgc:get') return (await chrome.storage.session.get(key))[key] ?? app.freshCache();
    if (message.type === 'mbgc:clear') {
      const cleared = { ...app.freshCache(), clearedAt: Date.now() };
      await chrome.storage.session.set({ [key]: cleared });
      await chrome.storage.local.remove(overrideKey);
      void notify(account, sender.tab?.id).catch(() => {});
      return cleared;
    }
    if (message.type === 'mbgc:scan') {
      const stored = (await chrome.storage.session.get(key))[key] ?? app.freshCache();
      const before = JSON.stringify(stored);
      for (const snapshot of message.snapshots) {
        if (!stored.clearedAt || snapshot.at > stored.clearedAt) app.mergeScan(stored, snapshot);
      }
      for (const check of message.checks ?? []) {
        if (!stored.clearedAt || check.at > stored.clearedAt) app.mergeCheck(stored, check);
      }
      if (before !== JSON.stringify(stored)) {
        stored.revision = (stored.revision ?? 0) + 1;
        await chrome.storage.session.set({ [key]: stored });
        void notify(account, sender.tab?.id).catch(() => {});
      }
      return stored;
    }
    if (message.type === 'mbgc:lease' || message.type === 'mbgc:release') {
      const leaseKey = key + ':lease';
      const refreshKey = key + ':refresh';
      const stored = await chrome.storage.session.get([leaseKey, refreshKey]);
      const lease = stored[leaseKey];
      if (message.type === 'mbgc:release') {
        if (lease?.token === message.token && lease.owner === sender.tab?.id) await chrome.storage.session.remove(leaseKey);
        return null;
      }
      const now = Date.now();
      if (lease?.until > now || now - (stored[refreshKey] ?? 0) < (message.manual || message.hasNewSources ? 3000 : message.interval)) return null;
      const token = crypto.randomUUID();
      await chrome.storage.session.set({ [refreshKey]: now, [leaseKey]: { token, owner: sender.tab?.id, until: now + 95000 } });
      return token;
    }
    throw new Error('Unrecognized storage operation.');
  });
  pending = work.catch(() => {});
  work.then((value) => respond({ value }), (error) => respond({ error: error.message }));
  return true;
});
