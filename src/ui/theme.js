(() => {
  const app = globalThis.MBGC;
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  const color = (value) => {
    if (!value || !CSS.supports('color', value)) return null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    let result;
    for (const sentinel of ['#000001', '#ffffff']) {
      ctx.fillStyle = sentinel;
      ctx.fillStyle = value;
      if (result && result !== ctx.fillStyle) return null;
      result = ctx.fillStyle;
    }
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return a >= 240 ? [r, g, b] : null;
  };
  const luminance = (rgb) => rgb.reduce((sum, value, i) => {
    const unit = value / 255;
    return sum + [0.2126, 0.7152, 0.0722][i] * (unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4);
  }, 0);
  const mix = (a, b, ratio) => a.map((value, i) => Math.round(value + (b[i] - value) * ratio));
  const css = (rgb) => `rgb(${rgb.join(' ')})`;

  function getTheme(anchor) {
    const body = document.body;
    const root = document.documentElement;
    const main = document.querySelector('main, [role="main"], #main-content');
    const styles = [main, anchor, body, root].filter(Boolean).map((node) => getComputedStyle(node));
    const declared = [main, body, root].filter(Boolean).flatMap((node) => [
      node.dataset.theme, node.dataset.bsTheme, node.dataset.colorScheme, node.className
    ]).join(' ');
    const background = [main, body, root].filter(Boolean).map((node) =>
      color(getComputedStyle(node).backgroundColor)).find(Boolean);
    const mode = /\b(?:dark|theme-dark|dark-mode)\b/i.test(declared) ? 'dark' :
      /\b(?:light|theme-light|light-mode)\b/i.test(declared) ? 'light' :
        background ? (luminance(background) < .28 ? 'dark' : 'light') : scheme.matches ? 'dark' : 'light';
    const dark = mode === 'dark';
    const fallback = dark ? [180, 158, 255] : [112, 76, 209];
    const candidates = styles.flatMap((style) => [
      '--managebac-primary', '--theme-primary', '--primary-color', '--accent-color', '--bs-primary', '--primary', '--accent'
    ].map((name) => style.getPropertyValue(name).trim())).filter(Boolean);
    if (anchor) {
      const nav = anchor.closest('nav, aside, [role="navigation"]') ?? anchor.parentElement;
      const active = nav?.querySelector('a[aria-current="page"]:not(.mbgc-nav), a.active:not(.mbgc-nav)');
      if (active) candidates.push(getComputedStyle(active).color, getComputedStyle(active).backgroundColor);
    }
    const accent = candidates.map(color).find((rgb) => rgb && Math.max(...rgb) - Math.min(...rgb) > 24) ?? fallback;
    const surfaces = dark ? [27, 25, 36] : [253, 252, 255];
    const backdrop = background && (luminance(background) < .28) === dark ? background : surfaces;
    const neutral = dark ? [239, 235, 255] : [31, 22, 53];
    let ink = accent;
    for (let i = 0; i < 12; i++) {
      const a = luminance(ink);
      const b = luminance(surfaces);
      if ((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 5.5) break;
      ink = mix(ink, neutral, .18);
    }
    return { mode, accent: css(accent), ink: css(ink), surface: css(mix(surfaces, backdrop, .15)) };
  }

  function applyTheme(node, theme) {
    node.dataset.theme = theme.mode;
    node.style.setProperty('--mbgc-accent', theme.accent);
    node.style.setProperty('--mbgc-ink', theme.ink);
    node.style.setProperty('--mbgc-surface', theme.surface);
  }

  Object.assign(app, { getTheme, applyTheme, scheme });
})();
