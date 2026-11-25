const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/core/grades.js');
require('../src/core/cache.js');
require('../src/core/goal-planner.js');
require('../src/core/grade-report.js');
require('../src/core/settings-backup.js');
const app = globalThis.MBGC;
const exportedAt = '2026-11-24T10:00:00.000Z';
const school = 'uia.managebac.com';
const task = (id, title, category, earnedPoints, maxPoints) => ({ id, title, category, earnedPoints, maxPoints,
  taskUrl: '/student/private-looking-url', cookie: 'sensitive-cookie' });
const records = {
  a: task('a', 'Essay, "Draft"\nSecond line', 'Writing', 8, 10),
  b: task('b', 'Survey', 'Writing', 0, 30),
  c: task('c', 'Discussion', 'Presentation', 18, 20),
  d: task('d', 'Homework', 'Writing', null, 24),
  e: { ...task('e', '=HYPERLINK("bad")', 'Writing', null, null), gradeKind: 'letter' },
  f: { ...task('f', 'Excluded', 'Writing', 14, 15), excluded: true }
};
const weights = { Writing: 30, Presentation: 70, Inactive: 25 };
const cache = { classes: { '123': { name: 'English, Literature', terms: {
  'term:71': { label: 'Semester 1', termId: '71', weights, records, complete: true, lastScan: 1795500000000 },
  'term:72': { label: 'Semester 2', termId: '72', weights, records: { x: task('x', 'Late exam', 'Writing', 2, 10) } },
  unknown: { label: 'Unidentified term', termId: null, weights, records }
} } }, credentials: 'cache-secret' };

const numeric = (received, expected) => assert.ok(Math.abs(received - expected) < 1e-9, `${received} ≈ ${expected}`);
test('method comparison uses identical graded inputs and respects subject, global, term and scale settings', () => {
  const settings = { method: 'points', subjectMethods: { '123': 'absolute' } };
  const input = app.gradeInputs(cache, settings, { weights: {}, scale: [[80, 'High'], [0, 'Developing']] }, '123', 'term:71');
  const comparison = app.compareMethods(input);
  assert.equal(comparison.term, 'Semester 1');
  assert.equal(comparison.rows.length, 3);
  const expected = [75, 69, (60 * 40 + 70 * 90) / 130];
  comparison.rows.forEach(({ percentage, letter }, index) => {
    numeric(percentage, expected[index]);
    assert.equal(letter, 'Developing');
  });
  assert.equal(comparison.rows.find((row) => row.active).method, 'absolute');
  numeric(comparison.rows[0].delta, expected[0] - expected[2]);
  assert.equal(settings.subjectMethods['123'], 'absolute');
  const next = app.compareMethods(app.gradeInputs(cache, { method: 'points' }, app.gradeOverrides, '123', 'term:72'));
  assert.equal(next.rows.find((row) => row.active).method, 'points');
  assert.equal(next.term, 'Semester 2');
  assert.ok(next.rows.every((row) => row.percentage === 20));
  assert.match(next.notice, /may be missing/);
});

test('comparison exposes missing weights, unverified terms, and all-ungraded buckets without fabricated grades', () => {
  const data = app.gradeInputs(cache, {}, app.gradeOverrides, '123', 'unknown');
  const unknown = app.compareMethods(data);
  assert.ok(unknown.rows.every((row) => row.percentage === null && row.letter === null));
  assert.match(unknown.notice, /verified term/);
  const invalid = app.compareMethods({ ...data, verified: true, weights: {} });
  assert.ok(invalid.rows.every((row) => row.percentage === null));
  assert.match(invalid.notice, /weights are missing/i);
  const blank = app.compareMethods({ ...data, verified: true, tasks: [records.d, records.e] });
  assert.ok(blank.rows.every((row) => row.percentage === null));
  assert.match(blank.notice, /No usable graded/);
});

test('versioned grade export preserves score states and neutralizes formula text in escaped UTF-8 CSV', () => {
  const report = app.gradeExport(cache, { method: 'points' }, app.gradeOverrides, exportedAt);
  assert.deepEqual([report.format, report.version, report.exportedAt], ['gradelens-grades', 1, exportedAt]);
  assert.equal(report.subjects[0].classId, '123');
  assert.equal(report.subjects[0].selectedMethod, 'points');
  const [term, second, unknown] = report.subjects[0].terms;
  assert.deepEqual([term.id, term.completeness, second.id, second.completeness, unknown.completeness], ['71', 'complete', '72', 'partial', 'unverified-term']);
  assert.equal(term.calculatedGrade.percentage, 69);
  assert.equal(unknown.calculatedGrade.percentage, null);
  assert.deepEqual(term.assessments.slice(1, 5).map(({ earnedPoints, gradeStatus }) => [earnedPoints, gradeStatus]),
    [[0, 'graded'], [18, 'graded'], [null, 'ungraded'], [null, 'missing-score']]);
  assert.equal(term.assessments.at(-1).excluded, true);
  assert.ok(!/sensitive-cookie|taskUrl|cache-secret/.test(JSON.stringify(report)));
  const csv = app.gradeCSV(report);
  assert.ok(csv.startsWith('\ufeffrow_type,subject,class_id,term,'));
  assert.match(csv, /"Essay, ""Draft""\nSecond line"/);
  assert.match(csv, /"English, Literature",123,Semester 1,71,complete,b,Survey,Writing,graded,false,0,30,0\.00,30,/);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /Percentage Weights with Points-Based Averaging,69\.00,C,2026/);
});

test('large exports keep every assessment and gracefully list classes with no term', () => {
  const input = structuredClone(cache);
  const bucket = input.classes['123'].terms['term:72'];
  bucket.records = Object.fromEntries(Array.from({ length: 9000 }, (_, i) => [i, task(String(i), 'Task ' + i, 'Writing', 7, 10)]));
  input.classes['456'] = { name: 'Art', terms: {} };
  const report = app.gradeExport(input, {}, app.gradeOverrides, exportedAt);
  assert.equal(JSON.parse(JSON.stringify(report)).subjects[0].terms[1].assessments.length, 9000);
  const csv = app.gradeCSV(report);
  assert.match(csv, /Task 8999,Writing,graded/);
  assert.ok(csv.includes('subject,Art,456,'));
});

const plan = { id: '00000000-0000-4000-8000-000000000000', classId: '123', termId: '71', name: 'Semester goal',
  targetType: 'letter', target: 'A', source: 'a0054b32', revision: 2, updatedAt: Date.parse(exportedAt),
  tasks: [{ id: 'future1', category: 'Writing', maxPoints: 10, precision: 'whole', fixed: null }] };
const prediction = { classId: '123', termId: '71', overrides: { writing: 84 },
  entries: [{ id: 'scenario:1', replaces: 'a', category: 'Writing', title: 'Essay', earnedPoints: 0, maxPoints: 10 }] };
const student = { weights: { '123': weights, '999': { Lab: 100 } }, scale: [[80, 'A'], [0, 'U']],
  goalPlans: [plan], predictions: [prediction], cookie: 'unrelated' };
function sampleBackup() {
  return app.makeBackup({ school, settings: { method: 'absolute', compareMethods: true, appearance: 'dark', academicTerm: 'term:71',
    subjectMethods: { '123': 'points', '999': 'percentage' }, authToken: 'secret' }, scope: { '123': ['71'], '999': ['73'] }, student, exportedAt });
}

test('settings backup round trips all preference types and retains only allowlisted, portable information', () => {
  const backup = sampleBackup();
  assert.equal(backup.version, 2);
  assert.ok(!JSON.stringify(backup).includes('secret'));
  assert.ok(!JSON.stringify(backup).includes('unrelated'));
  assert.deepEqual(app.readBackup(JSON.parse(JSON.stringify(backup))), backup);
  const current = { method: 'points', subjectMethods: { '123': 'absolute', '456': 'absolute' }, academicTerm: 'current' };
  const scoped = app.prepareRestore(backup, { school, scope: { '123': ['71'], '456': ['76'] }, settings: current,
    student: { weights: { '456': { Sketches: 100 } }, scale: null, predictions: [], goalPlans: [] } });
  assert.deepEqual(scoped.settings.subjectMethods, { '123': 'points', '456': 'absolute' });
  assert.equal(scoped.settings.method, 'absolute');
  assert.equal(scoped.settings.compareMethods, true);
  assert.equal(scoped.settings.academicTerm, 'term:71');
  assert.deepEqual(scoped.student.weights, { '123': weights, '456': { Sketches: 100 } });
  assert.deepEqual(scoped.student.scale, student.scale);
  assert.deepEqual(scoped.student.predictions[0].entries[0].earnedPoints, 0);
  assert.deepEqual(scoped.student.goalPlans[0], { ...plan, revision: 3 });
  assert.equal(scoped.preview.skippedClasses, 1);
  assert.equal(scoped.preview.skippedTerms, 1);
  assert.equal(scoped.preview.goalCount, 1);
  assert.deepEqual(current.subjectMethods, { '123': 'absolute', '456': 'absolute' });
});

test('missing plans in matched scopes are replaced, while unmatched terms, other schools, and unverified accounts stay isolated', () => {
  const backup = sampleBackup();
  const otherTerm = { ...plan, id: '00000000-0000-4000-8000-000000000001', termId: '72' };
  const target = { school, scope: { 123: ['71', '72'] }, settings: { method: 'points' },
    student: { weights: {}, scale: null, predictions: [prediction], goalPlans: [plan, otherTerm] } };
  const replaced = app.prepareRestore({ ...backup, student: { ...backup.student, predictions: [], goalPlans: [] } }, target);
  assert.deepEqual(replaced.student.goalPlans, [otherTerm]);
  assert.deepEqual(replaced.student.predictions, []);
  for (const destination of [{ ...target, school: 'different.managebac.com' }, { ...target, scope: {}, student: null }]) {
    const result = app.prepareRestore(backup, destination);
    assert.deepEqual(result.student, {});
    assert.deepEqual(result.settings.subjectMethods, {});
    assert.equal(result.settings.academicTerm, 'current');
    assert.equal(result.preview.studentSkipped, true);
  }
});

test('legacy compatible backups migrate and malformed or unsupported input cannot produce a restore patch', () => {
  const backup = sampleBackup();
  const old = app.readBackup({ format: backup.format, version: 1, school, exportedAt,
    settings: { appearance: 'light', subjectMethods: { 123: 'absolute' } }, student: { goalPlans: [plan] } });
  assert.equal(old.version, 2);
  assert.deepEqual(old.scope, { 123: ['71'] });
  assert.equal(old.preferences.compareMethods, undefined);
  assert.equal(old.student.goalPlans[0].name, 'Semester goal');
  const invalid = [
    [null, /Choose a GradeLens/], [{ ...backup, version: 99 }, /unsupported/], [{ ...backup, scope: null }, /scope/],
    [{ ...backup, preferences: { ...backup.preferences, compareMethods: 'yes' } }, /compareMethods/],
    [{ ...backup, student: { ...backup.student, weights: { '123': { Work: -1 } } } }, /weights/],
    [{ ...backup, student: { ...backup.student, goalPlans: [plan, plan] } }, /plan IDs/],
    [{ ...backup, student: { ...backup.student, predictions: [{ ...prediction, entries: [null] }] } }, /estimator/],
    [app.gradeExport(cache, {}, app.gradeOverrides, exportedAt), /cannot be restored/]
  ];
  for (const [object, reason] of invalid) {
    assert.throws(() => app.prepareRestore(object, { school, scope: {}, settings: {}, student: null }), reason);
  }
});
