(() => {
  const app = globalThis.MBGC ??= {};
  const scheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  const colors = new Map();
  let colorContext;
  const parseColor = (value) => {
    if (!value || !CSS.supports('color', value)) return null;
    const ctx = colorContext ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    let result;
    for (const sentinel of ['#000001', '#ffffff']) {
      ctx.fillStyle = sentinel;
      ctx.fillStyle = value;
      if (result && result !== ctx.fillStyle) return null;
      result = ctx.fillStyle;
    }
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return a >= 240 ? [r, g, b] : null;
  };
  const color = (value) => {
    if (!colors.has(value)) {
      if (colors.size >= 64) colors.clear();
      colors.set(value, parseColor(value));
    }
    return colors.get(value);
  };
  const luminance = (rgb) => rgb.reduce((sum, value, i) => {
    const unit = value / 255;
    return sum + [0.2126, 0.7152, 0.0722][i] * (unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4);
  }, 0);
  const mix = (a, b, ratio) => a.map((value, i) => Math.round(value + (b[i] - value) * ratio));
  const css = (rgb) => `rgb(${rgb.join(' ')})`;

  const nativeThemes = Object.freeze({
    orange: ['#FFFAEA', '#DB6903'],
    blue: ['#EFF8FF', '#1470EF'],
    teal: ['#EBF7F3', '#02857D'],
    red: ['#FEF3F2', '#D92D21'],
    plum: ['#F9F5F9', '#5D3460']
  });
  const modeFor = (preference, systemDark) => preference === 'dark' ||
    (preference !== 'light' && systemDark) ? 'dark' : 'light';
  const hex = (value) => value.slice(1).match(/../g).map((part) => Number.parseInt(part, 16));
  const contrast = (a, b) => {
    const first = luminance(a), second = luminance(b);
    return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
  };
  const accessible = (accent, surface, selected, dark) => {
    const neutral = dark ? [255, 255, 255] : [0, 0, 0];
    let ink = accent;
    for (let step = 0; step <= 20; step++) {
      ink = mix(accent, neutral, step / 20);
      if (contrast(ink, surface) >= 4.5 && contrast(ink, selected) >= 4.5) break;
    }
    return ink;
  };

  function themeTokens(mode, name, custom) {
    const dark = mode === 'dark';
    const palette = Object.hasOwn(nativeThemes, name ?? '') ? nativeThemes[name] : null;
    const surface = dark ? [29, 35, 44] : [253, 252, 255];
    const accent = palette ? hex(palette[1]) : custom ?? hex(nativeThemes.plum[1]);
    const selected = dark ? mix(surface, accent, name === 'plum' ? .35 : .23) :
      palette ? hex(palette[0]) : mix(surface, accent, .10);
    const ink = accessible(accent, surface, selected, dark);
    const black = [0, 0, 0], white = [255, 255, 255];
    const onAccent = contrast(accent, white) >= contrast(accent, black) ? white : black;
    return { mode, name: palette ? name : null, accent: css(accent), highlight: css(selected),
      ink: css(ink), onAccent: css(onAccent), surface: css(surface) };
  }

  const marker = (value) => value?.match(/^(?:(?:managebac|mb)[-_])?(?:theme[-_])?(orange|blue|teal|red|plum)(?:[-_]theme)?$/i)?.[1]?.toLowerCase();
  const knownColor = (rgb) => rgb && Object.keys(nativeThemes).find((name) =>
    nativeThemes[name].some((value) => hex(value).every((channel, index) => channel === rgb[index])));
  const themeAttributes = ['data-theme', 'data-mb-theme', 'data-managebac-theme', 'data-theme-color', 'data-color-scheme'];
  const accentVars = ['--managebac-primary', '--theme-primary', '--primary-accent', '--primary-color',
    '--accent-color', '--bs-primary', '--primary', '--accent'];

  function getTheme(anchor, preference = 'system') {
    const { documentElement: root, body } = document;
    const main = document.querySelector('main,[role="main"],#main-content');
    const roots = [root, body, main, anchor?.closest('.sidebar,aside,nav,[role="navigation"]'), anchor]
      .filter((node) => node && !node.closest('.mbgc-owned,.mbr-ui'));
    const mode = modeFor(preference, scheme.matches);
    for (const node of roots) {
      const name = [...themeAttributes.map((attr) => node.getAttribute(attr)), ...node.classList].map(marker).find(Boolean);
      if (name) return themeTokens(mode, name);
    }
    const candidates = roots.flatMap((node) => {
      const style = getComputedStyle(node);
      return accentVars.map((name) => color(style.getPropertyValue(name).trim())).filter(Boolean);
    });
    const name = candidates.map(knownColor).find(Boolean);
    const custom = candidates.find((rgb) => Math.max(...rgb) - Math.min(...rgb) > 24);
    return themeTokens(mode, name, custom);
  }

  function applyTheme(node, theme) {
    if (node.dataset.theme !== theme.mode) node.dataset.theme = theme.mode;
    for (const key of ['accent', 'highlight', 'ink', 'onAccent', 'surface']) {
      const property = '--mbgc-' + (key === 'onAccent' ? 'on-accent' : key);
      if (node.style.getPropertyValue(property) !== theme[key]) node.style.setProperty(property, theme[key]);
    }
  }

  Object.assign(app, { getTheme, applyTheme, scheme, modeFor, themeTokens, themeAttributes, nativeThemes });
})();
