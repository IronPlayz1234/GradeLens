importScripts('core/grades.js', 'core/cache.js');

const app = globalThis.MBGC;
const origin = 'https://uia.managebac.com';
let pending = Promise.resolve();
const leases = new Map();
async function notify(account, originTab) {
  const tabs = await chrome.tabs.query({ url: [origin + '/student', origin + '/student/*'] });
  await Promise.allSettled(tabs.filter((tab) => tab.id !== originTab).map((tab) =>
    chrome.tabs.sendMessage(tab.id, { type: 'mbgc:cache-updated', account })));
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.origin !== origin || sender.frameId !== 0 || !/^https:\/\/uia\.managebac\.com\/student(?:[/?#]|$)/.test(sender.url ?? '') ||
    typeof message !== 'object' || !message?.type?.startsWith('mbgc:')) return;
  const work = pending.then(async () => {
    const account = /^\d+$/.test(message.account ?? '') ? message.account : null;
    if (!account) throw new Error('A student account was not identified.');
    const key = `mbgc:cache:${new URL(origin).host}:${account}`;
    const overrideKey = `mbgc:overrides:${new URL(origin).host}:${account}`;
    if (message.type === 'mbgc:get') return (await chrome.storage.session.get(key))[key] ?? app.freshCache();
    if (message.type === 'mbgc:clear') {
      await chrome.storage.session.set({ [key]: { ...app.freshCache(), clearedAt: Date.now() } });
      await chrome.storage.local.remove(overrideKey);
      void notify(account, sender.tab?.id).catch(() => {});
      return null;
    }
    if (message.type === 'mbgc:scan') {
      const stored = (await chrome.storage.session.get(key))[key] ?? app.freshCache();
      for (const snapshot of message.snapshots) {
        if (!stored.clearedAt || snapshot.at > stored.clearedAt) app.mergeScan(stored, snapshot);
      }
      await chrome.storage.session.set({ [key]: stored });
      void notify(account, sender.tab?.id).catch(() => {});
      return stored;
    }
    if (message.type === 'mbgc:lease') {
      const now = Date.now();
      const lease = leases.get(key);
      if (lease && now < lease.until) return false;
      const leaseKey = key + ':refresh';
      const last = (await chrome.storage.session.get(leaseKey))[leaseKey] ?? 0;
      if (!message.manual && now - last < message.interval) return false;
      if (message.manual && now - last < 10000) return false;
      leases.set(key, { owner: sender.tab?.id, until: now + 130000 });
      await chrome.storage.session.set({ [leaseKey]: now });
      return true;
    }
    if (message.type === 'mbgc:release') {
      if (leases.get(key)?.owner === sender.tab?.id) leases.delete(key);
      return null;
    }
    throw new Error('Unrecognized storage operation.');
  });
  pending = work.catch(() => {});
  work.then((value) => respond({ value }), (error) => respond({ error: error.message }));
  return true;
});
