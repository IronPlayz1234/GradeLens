const assert = require('node:assert/strict');
const test = require('node:test');
require('../src/ui/theme.js');
require('../src/core/grades.js');
require('../src/core/cache.js');
const { themeTokens, modeFor, normalizeSettings, nativeThemes } = globalThis.MBGC;

const values = {
  orange: ['rgb(255 250 234)', 'rgb(219 105 3)'],
  blue: ['rgb(239 248 255)', 'rgb(20 112 239)'],
  teal: ['rgb(235 247 243)', 'rgb(2 133 125)'],
  red: ['rgb(254 243 242)', 'rgb(217 45 33)'],
  plum: ['rgb(249 245 249)', 'rgb(93 52 96)']
};
const luminance = (value) => value.match(/\d+/g).map((channel) => {
  const linear = Number(channel) / 255;
  return linear <= .04045 ? linear / 12.92 : ((linear + .055) / 1.055) ** 2.4;
}).reduce((total, channel, index) => total + channel * [.2126, .7152, .0722][index], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) /
  (Math.min(luminance(a), luminance(b)) + .05);

test('ManageBac palette colors remain exact with readable text in both modes', () => {
  assert.deepEqual(Object.keys(nativeThemes), Object.keys(values));
  for (const [name, [highlight, accent]] of Object.entries(values)) {
    assert.equal(themeTokens('light', name).highlight, highlight);
    assert.notEqual(themeTokens('dark', name).highlight, highlight);
    for (const mode of ['light', 'dark']) {
      const tokens = themeTokens(mode, name);
      assert.equal(tokens.accent, accent);
      assert.ok(contrast(tokens.ink, tokens.surface) >= 4.5);
      assert.ok(contrast(tokens.ink, tokens.highlight) >= 4.5);
      assert.ok(contrast(tokens.onAccent, tokens.accent) >= 4.5);
    }
  }
});

test('system follows OS and legacy appearance migrates without discarding preferences', () => {
  assert.equal(modeFor('system', false), 'light');
  assert.equal(modeFor('system', true), 'dark');
  assert.equal(modeFor('light', true), 'light');
  assert.equal(modeFor('dark', false), 'dark');
  const stored = normalizeSettings({ appearance: 'native', subjectMethods: { '123': 'points' } });
  assert.equal(stored.appearance, 'system');
  assert.equal(stored.subjectMethods['123'], 'points');
});
