// The browser remembers this document_start registration across restarts.
// Storage remains authoritative for live tabs and for every new document.
(() => {
  const app = globalThis.MBGC;
  const id = 'mbgc-appearance-primer';
  const key = app.preferencesKey;
  const matches = ['https://uia.managebac.com/student', 'https://uia.managebac.com/student/*'];
  let pending = Promise.resolve();

  function refreshAppearancePrimer() {
    pending = pending.catch(() => {}).then(async () => {
      const settings = app.normalizeSettings((await chrome.storage.local.get(key))[key]);
      const registry = chrome.scripting;
      if (!registry?.getRegisteredContentScripts) return;
      const [registered] = await registry.getRegisteredContentScripts({ ids: [id] });
      const mode = settings.enabled ? settings.appearance : 'light';
      if (mode === 'light') {
        if (registered) await registry.unregisterContentScripts({ ids: [id] });
        return;
      }
      const js = ['src/content/prime-' + mode + '.js'];
      if (registered?.js?.[0] === js[0]) return;
      const definition = { id, matches, js, runAt: 'document_start', persistAcrossSessions: true };
      if (registered) await registry.updateContentScripts([definition]);
      else await registry.registerContentScripts([definition]);
    });
    return pending;
  }

  const refresh = () => { void refreshAppearancePrimer().catch(() => {}); };
  chrome.runtime.onInstalled.addListener(refresh);
  chrome.runtime.onStartup.addListener(refresh);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, key)) return;
    const { oldValue, newValue } = changes[key];
    if (oldValue?.appearance !== newValue?.appearance || oldValue?.enabled !== newValue?.enabled) refresh();
  });
  app.refreshAppearancePrimer = refreshAppearancePrimer;
})();
