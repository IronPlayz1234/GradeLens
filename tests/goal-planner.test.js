const assert = require('node:assert/strict');
const test = require('node:test');
require('../src/core/grades.js');
require('../src/core/goal-planner.js');
const { calculate, solveGoalPlan, goalDataVersion, normalizedGoalPlan, defaultScale, letter } = globalThis.MBGC;

const record = (id, category, earnedPoints, maxPoints) => ({ id, category, earnedPoints, maxPoints });
const row = (id, category, maxPoints, fixed = null, precision = 'whole') => ({ id, category, maxPoints, fixed, precision });
const nearly = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} ≈ ${expected}`);
const weights = { Coursework: 30, Research: 30, Exam: 40 };
const tasks = [record('c1', 'Coursework', 8, 10), record('c2', 'Coursework', 15, 30), record('r1', 'Research', 18, 20)];
const future = [row('f1', 'Coursework', 10), row('f2', 'Coursework', 50), row('f3', 'Research', 20, 10)];

for (const [method, common, marks, predicted, max] of [
  ['percentage', 83, [9, 42, 10], 73, 76.25],
  ['points', 85, [9, 43, 10], 72.5, 76.5],
  ['absolute', 81, [9, 41, 10], 442 / 6, 470 / 6]
]) {
  test(`${method} solves a hand-calculated plan with mixed categories, denominators and fixed points`, () => {
    const plan = solveGoalPlan({ tasks, weights, method, future, target: 72 });
    assert.equal(plan.state, 'achieved');
    assert.equal(plan.currentMeets, true);
    nearly(plan.common, common);
    nearly(plan.predicted, predicted);
    nearly(plan.maximum, max);
    assert.deepEqual(plan.scores.map((task) => task.earnedPoints), marks);
    assert.ok(calculate([...tasks, ...plan.scores], weights, method).percentage >= 72);
    assert.ok(plan.reaches);
    assert.equal(plan.breakdown.find(({ name }) => name === 'Exam').taskCount, 0);
  });
}

test('decimal scores round up to hundredths and whole points meet an exact letter boundary', () => {
  const plan = solveGoalPlan({ tasks: [record('c', 'Studio', 6, 10)],
    weights: { Studio: 1, Inactive: 99 }, method: 'percentage',
    future: [row('e', 'Studio', 3.33, null, 'decimal'), row('f', 'Studio', 9)], target: 80 });
  nearly(plan.common, 90);
  assert.deepEqual(plan.scores.map(({ earnedPoints }) => earnedPoints), [3, 9]);
  assert.ok(plan.predicted >= 80);
  assert.equal(letter(plan.predicted, defaultScale), 'A');
  const boundary = solveGoalPlan({ tasks: [], weights: { Writing: 100 }, method: 'points',
    future: [row('1', 'Writing', 10), row('2', 'Writing', 20)], target: 90 });
  assert.equal(boundary.state, 'achievable');
  assert.equal(boundary.predicted, 90);
  assert.equal(letter(boundary.predicted), 'A*');
});

test('adding the first grade activates its category and renormalizes weights', () => {
  const existing = [record('1', 'Research', 9, 10), record('2', 'Exam', null, 100)];
  for (const method of ['percentage', 'points', 'absolute']) {
    const plan = solveGoalPlan({ tasks: existing, weights, method,
      future: [row('exam', 'Exam', 100)], target: 80 });
    assert.equal(plan.state, 'achieved');
    assert.equal(plan.current.percentage, 90);
    nearly(plan.common, 72.5);
    assert.equal(plan.scores[0].earnedPoints, 73);
    assert.equal(plan.minimum, 2700 / 70);
    assert.ok(plan.predicted >= 80);
  }
});

test('current achievement can still become impossible under a plan with low fixed marks', () => {
  const plan = solveGoalPlan({ tasks: [record('1', 'Work', 10, 10)], weights: { Work: 100 },
    method: 'points', target: 90, future: [row('fixed', 'Work', 10, 0), row('unknown', 'Work', 10)] });
  assert.equal(plan.state, 'impossible');
  assert.equal(plan.currentMeets, true);
  assert.equal(plan.reaches, false);
  nearly(plan.maximum, 200 / 3);
  assert.deepEqual(plan.scores.map((task) => task.earnedPoints), [0, 10]);
});

test('no existing grades, fixed-only plans, excluded work, and zero weights have distinct outcomes', () => {
  const context = { tasks: [{ ...record('a', 'Art', 0, 10), excluded: true }], weights: { Art: 100, Sketches: 0 },
    method: 'absolute', target: 80 };
  const plan = solveGoalPlan({ ...context, future: [row('1', 'Art', 25, 20), row('2', 'Sketches', 100)] });
  assert.equal(plan.current.percentage, null);
  assert.equal(plan.state, 'achieved');
  assert.equal(plan.common, null);
  assert.equal(plan.predicted, 80);
  assert.equal(plan.scores[1].earnedPoints, 0);
  const noWeight = solveGoalPlan({ ...context, future: [row('2', 'Sketches', 100)] });
  assert.equal(noWeight.state, 'unavailable');
});

test('invalid targets, missing categories and marks, duplicate IDs, and empty plans are rejected', () => {
  const context = { tasks, weights, method: 'percentage', target: 72 };
  for (const amendment of [
    { future: [] }, { target: null }, { target: 101 }, { target: -1 },
    { future: [row('1', 'Unknown', 10)] }, { future: [row('1', '', 10)] },
    { future: [row('1', 'Research', 0)] }, { future: [row('1', 'Research', 10, -1)] },
    { future: [row('1', 'Research', 10, 11)] }, { future: [row('1', 'Research', 10.5)] },
    { future: [row('1', 'Research', 10, 1.001, 'decimal')] }, { future: [future[0], future[0]] }
  ]) assert.equal(solveGoalPlan({ ...context, future, ...amendment }).state, 'unavailable');
  const unknownWeight = solveGoalPlan({ ...context, tasks: [...tasks, record('z', 'Unweighted', 8, 10)], future });
  assert.match(unknownWeight.reason, /Unweighted/);
});

test('storage shape separates subjects and terms and data fingerprints reflect only calculation inputs', () => {
  const data = { tasks, weights, method: 'percentage', scale: defaultScale };
  const source = goalDataVersion(data);
  assert.equal(goalDataVersion({ ...data, tasks: [...tasks].reverse(), weights: { Exam: 40, Research: 30, Coursework: 30 } }), source);
  assert.notEqual(goalDataVersion({ ...data, method: 'points' }), source);
  assert.notEqual(goalDataVersion({ ...data, tasks: [...tasks, record('late', 'Research', 3, 10)] }), source);
  const plan = { id: '00000000-0000-4000-8000-000000000000', classId: '123', termId: 'semester.2',
    name: ' Winter goal ', targetType: 'letter', target: 'A', source, tasks: future, unwanted: true };
  const stored = normalizedGoalPlan(plan);
  assert.equal(stored.name, 'Winter goal');
  assert.equal(stored.termId, 'semester.2');
  assert.equal(stored.classId, '123');
  assert.ok(!Object.hasOwn(stored, 'unwanted'));
  assert.throws(() => normalizedGoalPlan({ ...plan, termId: '/' }));
});
