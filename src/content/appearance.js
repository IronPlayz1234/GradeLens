// Apply the saved appearance before the full content script starts.
(() => {
  const key = 'mbgc:preferences';
  const { scheme, modeFor } = globalThis.MBGC;
  const root = document.documentElement;
  let settings;
  let revision = 0;
  const update = () => {
    const dark = settings?.enabled !== false && modeFor(settings?.appearance, scheme.matches) === 'dark';
    root.toggleAttribute('data-mbgc-native-dark', dark && !root.hasAttribute('data-mbr-mode') &&
      /^\/student(?:\/|$)/.test(location.pathname));
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, key)) return;
    revision++;
    settings = changes[key].newValue;
    update();
  });
  chrome.storage.local.get(key).then((stored) => {
    if (revision) return;
    settings = stored[key];
    update();
  }).catch(() => {});
  scheme.addEventListener('change', update);
  new MutationObserver(update).observe(root, { attributes: true, attributeFilter: ['data-mbr-mode'] });
  window.navigation?.addEventListener('currententrychange', update);
  window.addEventListener('popstate', update);
})();
