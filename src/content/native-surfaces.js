// Handle unfamiliar neutral wrappers inside the student content area. Explicit
// semantic CSS covers known components. This adapter only repairs missed light fills.
(() => {
  const app = globalThis.MBGC;
  const root = document.documentElement;
  const dark = 'data-mbgc-native-dark';
  const marker = 'data-mbgc-neutral-surface';
  const region = 'main,[role="main"],#content,#main-content,.main-content,.workspace-content';
  const wrapper = 'section,article,header,[role="region"],div[class],div[style],a[class]';
  const excluded = '.mbgc-owned,.mbr-ui,.badge,.alert,.fc-event,[data-category-color],[data-banner-artwork],.banner-artwork,[role="img"],[data-event-color]';
  const semantic = /(?:^|[-_\s])(?:badge|status|success|danger|warning|info|event|chip|tag|artwork|illustration|avatar|button|btn|icon)(?:$|[-_\s])/i;
  const pending = new Set();
  const marked = new Set();
  let frame = 0;
  let content;
  let observer;

  function inspect(node) {
    if (!node.isConnected) { marked.delete(node); return; }
    // An already marked wrapper needs its underlying native declaration checked again
    // when the site changes its class or style.
    if (marked.delete(node)) node.removeAttribute(marker);
    if (node.closest(excluded) || semantic.test(node.getAttribute('class') ?? '')) return;
    const native = getComputedStyle(node);
    if (native.backgroundImage !== 'none') return;
    const color = native.backgroundColor.match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/);
    if (!color) return;
    const channels = color.slice(1).map(Number);
    if (Math.min(...channels) < 210 || Math.max(...channels) - Math.min(...channels) > 27) return;
    const { width, height } = node.getBoundingClientRect();
    if (width >= 140 && height >= 44) {
      node.setAttribute(marker, '');
      marked.add(node);
    }
  }

  function flush() {
    frame = 0;
    if (!root.hasAttribute(dark)) { pending.clear(); return; }
    let count = 0;
    for (const node of pending) {
      pending.delete(node);
      inspect(node);
      if (++count === 48) break;
    }
    if (pending.size) frame = requestAnimationFrame(flush);
  }

  function schedule(node, children = false) {
    if (!(node instanceof Element) || node.closest(excluded)) return;
    if (node.matches(wrapper)) pending.add(node);
    if (children) {
      for (const descendant of node.querySelectorAll(wrapper)) {
        if (pending.size >= 240) break;
        if (!descendant.hasAttribute(marker)) pending.add(descendant);
      }
    }
    if (!frame && pending.size) frame = requestAnimationFrame(flush);
  }

  function bind() {
    if (!root.hasAttribute(dark)) {
      observer?.disconnect();
      content = null;
      pending.clear();
      for (const node of marked) node.removeAttribute(marker);
      marked.clear();
      return;
    }
    const next = document.querySelector(region);
    if (!next || next === content) return;
    observer?.disconnect();
    for (const node of marked) {
      if (next.contains(node)) continue;
      node.removeAttribute(marker);
      marked.delete(node);
    }
    content = next;
    observer ??= new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') schedule(record.target);
        else for (const node of record.addedNodes) schedule(node, true);
      }
    });
    observer.observe(content, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
    schedule(content, true);
  }

  new MutationObserver(bind).observe(root, { attributes: true, attributeFilter: [dark] });
  app.bindNativeSurfaces = bind;
  bind();
})();
