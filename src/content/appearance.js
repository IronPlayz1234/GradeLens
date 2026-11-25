// A browser-registered primer can paint the saved mode before the asynchronous
// storage read settles. This controller then owns the same flag for the tab.
(() => {
  const key = 'mbgc:preferences';
  const app = globalThis.MBGC;
  const { scheme, modeFor } = app;
  const root = document.documentElement;
  const flag = 'data-mbgc-native-dark';
  let settings;
  let primedMode;
  let ready = false;
  let revision = 0;

  function update() {
    const mode = ready ? settings?.appearance ?? 'system' : primedMode;
    const eligible = /^\/student(?:\/|$)/.test(location.pathname) && !root.hasAttribute('data-mbr-mode');
    const dark = eligible && mode && settings?.enabled !== false && modeFor(mode, scheme.matches) === 'dark';
    if (!dark) root.removeAttribute(flag);
    else {
      const value = ready ? '' : 'primed';
      if (root.getAttribute(flag) !== value) root.setAttribute(flag, value);
    }
  }

  app.primeNativeAppearance = (mode) => {
    if (ready) return;
    primedMode = mode;
    update();
  };

  const commit = (value) => {
    settings = value;
    ready = true;
    update();
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, key)) return;
    revision++;
    commit(changes[key].newValue);
  });
  chrome.storage.local.get(key).then((stored) => {
    if (!revision) commit(stored[key]);
  }).catch(() => {});
  scheme.addEventListener('change', update);
  new MutationObserver(update).observe(root, { attributes: true, attributeFilter: ['data-mbr-mode'] });
  window.navigation?.addEventListener('currententrychange', update);
  window.addEventListener('popstate', update);
})();
