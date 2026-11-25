// Fallback for native paint the component theme hasn't covered. Inspect effective
// colors and fix contrast locally without replacing the site's stylesheet.
(() => {
  const root = document.documentElement;
  const dark = 'data-mbgc-native-dark';
  const fill = 'data-mbgc-neutral-surface';
  const ink = 'data-mbgc-paint-ink';
  const ignored = [
    '.mbgc-owned', '.mbr-ui', '.badge', '[data-status]', '[data-category-color]',
    '[data-event-color]', '[data-banner-artwork]', '.banner-artwork', '[role="img"]',
    '[data-mbgc-audit-tone]', 'svg', 'img', 'picture', 'video', 'canvas', 'iframe', 'script', 'style', 'template'
  ].join(',');
  const control = 'button,input,select,textarea,[role="button"]';
  const widget = 'a[href],summary,[role="menuitem"],' + control;
  const queue = new Map();
  const marked = new Set();
  let frame = 0;
  let walk;
  let active = false;
  let stylesheet;

  function rgba(value) {
    const rgb = value.match(/^rgba?\(([^)]+)\)$/);
    if (rgb) {
      const [r, g, b, a = 1] = rgb[1].split(/[, /]+/).map(Number);
      if ([r, g, b, a].every(Number.isFinite)) return [r, g, b, a];
    }
    const srgb = value.match(/^color\(srgb ([^)]+)\)$/);
    if (srgb) {
      const [r, g, b, a = 1] = srgb[1].split(/[ /]+/).map(Number);
      if ([r, g, b, a].every(Number.isFinite)) return [r * 255, g * 255, b * 255, a];
    }
    if (/^#[0-9a-f]{6}$/i.test(value)) return [1, 3, 5].map((n) => parseInt(value.slice(n, n + 2), 16)).concat(1);
    return null;
  }

  const luminance = ([r, g, b]) => [r, g, b].reduce((sum, value, i) => {
    const unit = Math.min(255, Math.max(0, value)) / 255;
    return sum + [.2126, .7152, .0722][i] * (unit <= .04045 ? unit / 12.92 : ((unit + .055) / 1.055) ** 2.4);
  }, 0);
  const contrast = (a, b) => {
    const fg = luminance(a), bg = luminance(b);
    return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
  };
  const mix = (a, b, amount) => a.slice(0, 3).map((value, i) => Math.round(value + (b[i] - value) * amount));
  const composite = (front, back) => front[3] === 1 ? front : back && [...mix(back, front, front[3]), 1];
  const css = ([r, g, b, a = 1]) => `rgba(${r}, ${g}, ${b}, ${a})`;

  function darken(node, background, palette) {
    const brightness = luminance(background);
    if (brightness < .56 || background[3] < .12) return null;
    // Retain a hint of the original hue and keep pale foreground panels distinct.
    const base = node.matches(control) ? palette.control : brightness >= .82 ? palette.surface : palette.raised;
    const average = background.slice(0, 3).reduce((sum, value) => sum + value, 0) / 3;
    return base.slice(0, 3).map((value, i) =>
      Math.round(Math.min(255, Math.max(0, value + (background[i] - average) * .18)))).concat(background[3]);
  }

  function readable(foreground, surface, palette) {
    if (!foreground || !surface || foreground[3] < .45 ||
        contrast(composite(foreground, surface), surface) >= 4.5) return null;
    let target = contrast(palette.light, surface) >= contrast(palette.dark, surface) ? palette.light : palette.dark;
    if (contrast(target, surface) < 4.5) target = luminance(surface) < .18 ? [255, 255, 255] : [0, 0, 0];
    const channels = foreground.slice(0, 3);
    if (Math.max(...channels) - Math.min(...channels) <= 34) return target;
    // Prefer a small contrast lift for colored labels instead of replacing their hue.
    for (let step = 2; step < 10; step++) {
      const candidate = mix(foreground, target, step / 10);
      if (contrast(candidate, surface) >= 4.5) return candidate;
    }
    return contrast(target, surface) >= 4.5 ? target : null;
  }

  const excluded = (node) => !(node instanceof HTMLElement) || node.matches(ignored);
  const paintsText = (node) => node.matches(widget) ||
    Array.prototype.some.call(node.childNodes, (child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim());

  function clearPaint(node) {
    if (!marked.delete(node)) return;
    node.removeAttribute(fill);
    node.removeAttribute(ink);
  }

  function sampleBatch(nodes) {
    // Temporarily lift our values on the nodes being reevaluated. Read first,
    // then commit the entire batch before the browser paints.
    for (const node of nodes) clearPaint(node);
    const theme = getComputedStyle(root);
    const token = (name) => rgba(theme.getPropertyValue('--mbgc-native-' + name).trim());
    const palette = {
      page: token('bg'), surface: token('surface'), raised: token('secondary'), control: token('control'),
      light: token('text') ?? [255, 255, 255], dark: [0, 0, 0]
    };
    if (!palette.page || !palette.surface || !palette.raised || !palette.control) return;
    const changes = new Map();
    const sampled = new WeakMap();
    function sample(node) {
      if (!node || node === root) return { surface: palette.page };
      if (sampled.has(node)) return sampled.get(node);
      const style = getComputedStyle(node);
      const background = rgba(style.backgroundColor);
      // Image and gradient paint can't be inferred from background-color.
      const flat = style.backgroundImage === 'none';
      const replacement = flat && background && darken(node, background, palette);
      let surface = null;
      if (flat && background) {
        const paint = replacement || background;
        surface = paint[3] === 1 ? paint : composite(paint, sample(node.parentElement).surface);
      }
      const result = { fill: replacement, surface, color: style.color };
      sampled.set(node, result);
      return result;
    }
    for (const node of nodes) {
      if (!node.isConnected || node.closest(ignored)) continue;
      const colors = sample(node);
      const text = paintsText(node) && readable(rgba(colors.color), colors.surface, palette);
      if (colors.fill || text) changes.set(node, [colors.fill, text]);
    }
    for (const [node, [background, text]] of changes) {
      if (background) node.setAttribute(fill, css(background));
      if (text) node.setAttribute(ink, css(text));
      marked.add(node);
    }
  }

  function advance() {
    while (walk || queue.size) {
      if (walk) {
        const { walker, start } = walk;
        if (!start.isConnected) { walk = null; continue; }
        const next = walker.nextNode();
        if (next) { queue.delete(next); return next; }
        walk = null;
        continue;
      }
      const [node, deep] = queue.entries().next().value;
      queue.delete(node);
      if (!node.isConnected || node.closest(ignored)) continue;
      if (deep) walk = { start: node, walker: document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT,
        (child) => excluded(child) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) };
      return node;
    }
    return null;
  }

  function flush() {
    frame = 0;
    if (!active) return;
    // Cap each batch to keep scrolling and typing responsive on large task lists.
    const batch = new Set();
    for (let i = 0; i < 80; i++) {
      const node = advance();
      if (!node) break;
      batch.add(node);
    }
    if (batch.size) sampleBatch(batch);
    if (walk || queue.size) frame = requestAnimationFrame(flush);
  }

  function schedule(node, deep = true) {
    if (!(node instanceof HTMLElement) || node.closest(ignored)) return;
    queue.set(node, deep || queue.get(node));
    if (!frame) frame = requestAnimationFrame(flush);
  }

  function pageChanged() {
    schedule(document.body);
  }

  const observer = new MutationObserver((records) => {
    let removed = false;
    for (const record of records) {
      const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      if (!element || element.closest('.mbgc-owned,.mbr-ui')) continue;
      if (element.closest('head') || element === root && record.type === 'attributes') {
        pageChanged();
        continue;
      }
      if (record.type !== 'childList') {
        schedule(element, record.type === 'attributes');
        continue;
      }
      // Scheduling just the changed branch avoids rescanning the rest of a portal or table.
      removed ||= record.removedNodes.length > 0;
      schedule(element, false);
      for (const node of record.addedNodes) schedule(node);
    }
    // Release references to disconnected portal and list nodes.
    if (removed) for (const node of marked) if (!node.isConnected) clearPaint(node);
  });

  function state() {
    const enabled = root.hasAttribute(dark);
    if (enabled === active) return;
    active = enabled;
    if (active) {
      // A user-origin stylesheet reaches authored inline !important fills. The
      // manifest copy still applies if the worker is temporarily unavailable.
      if (!stylesheet) {
        stylesheet = Promise.resolve().then(() => chrome.runtime.sendMessage({ type: 'mbgc:native-paint-css' })).then((loaded) => {
          if (loaded && active) pageChanged();
          if (!loaded) stylesheet = undefined;
        }).catch(() => { stylesheet = undefined; });
      }
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-expanded', 'aria-selected', 'aria-current',
          'data-theme', 'data-mbgc-audit-part', 'data-mbgc-audit-tone', 'data-mbgc-audit-surface',
          'data-mbgc-audit-selected', 'data-mbgc-nav-native'] });
      pageChanged();
    } else {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      walk = null;
      queue.clear();
      for (const node of marked) clearPaint(node);
    }
  }

  // Hover/focus can change native CSS without a DOM mutation.
  const interaction = (event) => {
    if (!active || !(event.target instanceof Element)) return;
    schedule(event.target, false);
    schedule(event.target.closest(widget));
  };
  for (const event of ['pointerover', 'pointerout', 'focusin', 'focusout']) {
    document.addEventListener(event, interaction, true);
  }
  document.addEventListener('load', (event) => {
    if (active && event.target.matches?.('link[rel="stylesheet"]')) pageChanged();
  }, true);
  new MutationObserver(state).observe(root, { attributes: true, attributeFilter: [dark] });
  state();
})();
