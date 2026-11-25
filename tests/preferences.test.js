const assert = require('node:assert/strict');
const test = require('node:test');
require('../src/core/grades.js');
require('../src/core/cache.js');
const { normalizeSettings, patchSettings, methodFor } = globalThis.MBGC;

test('subject methods survive serialization independently of other preferences and the global method', () => {
  const previous = { method: 'absolute', refreshMinutes: 12, progressBars: false, memory: 'retained' };
  const one = patchSettings(previous, { subject: { id: '123', method: 'points' } });
  const two = patchSettings(one, { subject: { id: '456', method: 'absolute' }, patch: { method: 'percentage' } });
  const next = normalizeSettings(JSON.parse(JSON.stringify(two)));
  assert.deepEqual([methodFor(next, '123'), methodFor(next, '456'), methodFor(next, '789')],
    ['points', 'absolute', 'percentage']);
  assert.equal(next.refreshMinutes, 12);
  assert.equal(next.progressBars, false);
  assert.equal(next.memory, 'retained');
  const reset = patchSettings(next, { subject: { id: '123', method: '' } });
  assert.equal(methodFor(reset, '123'), 'percentage');
  assert.equal(methodFor(reset, '456'), 'absolute');
  assert.equal(Object.hasOwn(reset.subjectMethods, '123'), false);
  assert.throws(() => patchSettings(reset, { subject: { id: 'Physics', method: 'points' } }));
  assert.throws(() => patchSettings(reset, { subject: { id: '123', method: '__proto__' } }));
});
