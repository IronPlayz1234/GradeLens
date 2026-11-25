const assert = require('node:assert/strict');
const test = require('node:test');
require('../src/core/grades.js');
const { calculate, letter, normalizeScale, targetScore, withHypotheticals } = globalThis.MBGC;
const weights = { Coursework: 30, Research: 30, 'Semester Exam': 40 };
const task = (category, earnedPoints, maxPoints, id) => ({ category, earnedPoints, maxPoints, id });
const tasks = [task('Coursework', 8, 10, '1'), task('Coursework', 15, 30, '2'), task('Research', 18, 20, '3'), task('Semester Exam', 70, 100, '4')];
const nearly = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-9, `${value} differs from ${expected}`);

for (const [method, expected] of Object.entries({ percentage: 74.5, points: 72.25, absolute: 9400 / 130 })) {
  test(method + ' matches the documented example', () => nearly(calculate(tasks, weights, method).percentage, expected));
}

test('normalizes active weights and counts valid zero and formative scores', () => {
  const input = [{ ...task(' coursework ', 0, 10), assessmentType: 'Formative' }, tasks[2], { category: 'Semester Exam' }];
  const result = calculate(input, weights, 'percentage');
  assert.equal(result.percentage, 45);
  assert.equal(result.ungraded, 1);
  assert.equal(result.count, 2);
  assert.equal(calculate(tasks, { ...weights, Research: 0 }).weightedCount, 3);
});

test('missing and invalid weights or scores cannot manufacture a grade', () => {
  assert.equal(calculate(tasks, {}).percentage, null);
  assert.equal(calculate(tasks, { ...weights, Coursework: -1 }).percentage, null);
  assert.equal(calculate([task('Coursework', 30, 10), task('Research', undefined, 10)], weights).percentage, null);
  assert.equal(calculate([task('Coursework', 0, 10)], { Coursework: 0 }).percentage, null);
  assert.equal(calculate([], weights).percentage, null);
});

test('letter scale compares unrounded values and validates custom boundaries', () => {
  assert.equal(letter(89.995), 'A');
  assert.equal(letter(90), 'A*');
  assert.equal(letter(0), 'U');
  assert.equal(letter(null), null);
  assert.equal(letter(85, normalizeScale([[0, 'Below'], [85, 'Top']])), 'Top');
  assert.equal(normalizeScale([[20, 'A']]), null);
  assert.equal(normalizeScale([[0, 'A'], [80, 'a']]), null);
  assert.equal(calculate([task('Coursework', 2, 3)], weights).percentage, 66.66666666666667);
});

const future = task('Semester Exam', 90, 100, 'future');
for (const [method, [expected, required]] of Object.entries({
  percentage: [78.5, 97.5],
  points: [76.25, 108.75],
  absolute: [13000 / 170, 105]
})) {
  test(method + ' forecasts a new exam and solves the target', () => {
    nearly(calculate(withHypotheticals(tasks, [future]), weights, method).percentage, expected);
    const result = targetScore({ tasks, weights, method, future, target: 80 });
    if (required > 100) {
      assert.equal(result.state, 'impossible');
      nearly(result.predicted, method === 'points' ? 78.25 : 13400 / 170);
    } else {
      assert.equal(result.state, 'achievable');
      nearly(result.required, required);
      nearly(result.predicted, 80);
    }
  });
}

test('letter target and replacement use the configured threshold without changing actual records', () => {
  const target = normalizeScale([[80, 'A'], [0, 'U']]).find(([, label]) => label === 'A')[0];
  const replaced = { ...future, replaces: '4' };
  const before = structuredClone(tasks);
  const result = targetScore({ tasks, weights, method: 'percentage', future: replaced, target });
  nearly(result.required, 83.75);
  assert.equal(result.state, 'achievable');
  assert.deepEqual(tasks, before);
  assert.equal(withHypotheticals(tasks, [replaced]).length, 4);
});

test('targets handle zero required, exact maxima and unavailable inputs', () => {
  const input = { tasks, weights, method: 'percentage', future: { ...future, replaces: '4' } };
  assert.equal(targetScore({ ...input, target: 20 }).state, 'achieved');
  assert.equal(targetScore({ ...input, target: 86.5 }).required, 100);
  assert.equal(targetScore({ ...input, target: 100 }).state, 'impossible');
  assert.equal(targetScore({ ...input, target: 80, overrides: { 'semester exam': 95 } }).state, 'unavailable');
  assert.equal(targetScore({ ...input, target: NaN }).state, 'unavailable');
});

test('category overrides are separate assumptions and use the modeled count for Absolute Weights', () => {
  const result = calculate(tasks.slice(0, 3), weights, 'absolute', { 'semester exam': 80 });
  nearly(result.percentage, 9800 / 130);
  assert.equal(result.breakdown.find((item) => item.name === 'Semester Exam').simulated, true);
  assert.equal(tasks.length, 4);
});
