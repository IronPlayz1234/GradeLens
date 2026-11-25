const assert = require('node:assert/strict');
const test = require('node:test');
require('../src/core/grades.js');
require('../src/core/cache.js');
require('../src/core/goal-planner.js');
require('../src/core/grade-report.js');
require('../src/core/history.js');
require('../src/core/settings-backup.js');
const app = globalThis.MBGC;
const first = Date.parse('2026-11-24T09:00:00.000Z');
const paper = (id, points, category = 'Work', maximum = 10) =>
  ({ id, title: 'Assessment ' + id, category, earnedPoints: points, maxPoints: maximum });
const scope = app.historyKey('123', '71');
const gradeCache = () => ({ classes: { 123: { name: 'Chemistry', terms: {
  'term:71': { termId: '71', label: 'Semester 1', weights: { Work: 60, Exam: 40 },
    records: { a: paper('a', 8), b: paper('b', 7, 'Exam') }, complete: true }
} } }, clearedAt: 0 });
const bucket = (cache) => cache.classes['123'].terms['term:71'];
const events = (history) => history.terms[scope]?.events ?? [];
const method = (value) => ({ method: value, subjectMethods: {} });
function start(cache = gradeCache()) {
  const history = { ...app.emptyHistory(), enabled: true, startedAt: first };
  app.observeHistory(history, cache, method('percentage'), {}, { at: first });
  return history;
}

test('history starts at activation using only verified calculable cached grades', () => {
  const cache = gradeCache();
  cache.classes['123'].terms.unknown = { records: { a: paper('a', 10) }, weights: { Work: 100 } };
  const history = app.emptyHistory();
  assert.equal(app.observeHistory(history, cache, method('percentage'), {}, { at: first - 10000 }), false);
  assert.deepEqual(history.terms, {});
  history.enabled = true;
  history.startedAt = first;
  assert.ok(app.observeHistory(history, cache, method('percentage'), {}, { at: first }));
  assert.deepEqual(Object.keys(history.terms), [scope]);
  const [baseline] = events(history);
  assert.deepEqual([baseline.at, baseline.percentage, baseline.count, baseline.kinds, baseline.delta],
    [first, 76, 2, ['baseline'], null]);
  const refresh = structuredClone(cache);
  bucket(refresh).records.a.observedAt = first + 40;
  bucket(refresh).lastScan = first + 40;
  assert.equal(app.observeHistory(history, refresh, method('percentage'), {}, { at: first + 40, beforeCache: cache }), false);
  assert.equal(events(history).length, 1);
});

test('new valid marks, corrections and authoritative removals are grouped and have a verified aggregate delta', () => {
  const cache = gradeCache();
  const history = start(cache);
  const next = structuredClone(cache);
  bucket(next).records.a = paper('a', 18, 'Work', 20);
  delete bucket(next).records.b;
  bucket(next).records.d = paper('d', 9, 'Exam');
  bucket(next).records.ungraded = { ...paper('x', null), title: 'Not graded' };
  assert.ok(app.observeHistory(history, next, method('percentage'), {}, { at: first + 1, beforeCache: cache }));
  const event = events(history)[1];
  assert.equal(event.id.length, 36);
  assert.deepEqual(event.kinds.sort(), ['corrected-grade', 'new-grade', 'removed-grade']);
  assert.equal(event.percentage, app.calculate(Object.values(bucket(next).records), bucket(next).weights, 'percentage').percentage);
  assert.equal(event.percentage, 90);
  assert.equal(event.letter, 'A*');
  assert.equal(event.delta, 14);
  assert.equal(event.previousId, events(history)[0].id);
  assert.deepEqual(event.changes.map((item) => item.id).sort(), ['a', 'b', 'd']);
  assert.deepEqual(app.historySeries(events(history)).map((item) => item.length), [2]);
  assert.equal(app.observeHistory(history, next, method('percentage'), {}, { at: first + 2, beforeCache: next }), false);
});

test('method, category assignments, weights and scale changes break the performance line', () => {
  const cache = gradeCache();
  const history = start(cache);
  const move = structuredClone(cache);
  bucket(move).records.b.category = 'Work';
  const checkpoints = [
    [cache, method('absolute'), {}, 'method'],
    [move, method('absolute'), {}, 'category'],
    [move, method('absolute'), { weights: { 123: { Work: 70, Exam: 30 } } }, 'weights'],
    [move, method('absolute'), { weights: { 123: { Work: 70, Exam: 30 } }, scale: [[90, 'A'], [0, 'F']] }, 'scale']
  ];
  let previous = cache;
  checkpoints.forEach(([next, prefs, overrides, expected], index) => {
    assert.ok(app.observeHistory(history, next, prefs, overrides, { at: first + index + 1, beforeCache: previous }));
    const event = events(history).at(-1);
    assert.deepEqual(event.kinds, [expected]);
    assert.equal(event.delta, null);
    assert.equal(event.previousId, null);
    previous = next;
  });
  assert.deepEqual(app.historySeries(events(history)).map((item) => item.length), [1, 1, 1, 1, 1]);
});

test('changed terms, unfinished scans, absent grades and paused tracking remain separate', () => {
  const cache = gradeCache();
  const history = start(cache);
  const other = structuredClone(cache);
  other.classes['123'].terms['term:72'] = { ...structuredClone(bucket(cache)), termId: '72', label: 'Semester 2' };
  other.classes['456'] = { name: 'Art', terms: {
    'term:71': { termId: '71', weights: { Studio: 100 }, records: { a: paper('a', null, 'Studio') } }
  } };
  app.observeHistory(history, other, method('percentage'), {}, { at: first + 1, beforeCache: cache });
  assert.equal(history.terms['123:72'].events[0].kinds[0], 'baseline');
  assert.equal(history.terms['456:71'], undefined);
  assert.equal(events(history).length, 1);
  const incomplete = structuredClone(other);
  bucket(incomplete).records = {};
  bucket(incomplete).complete = false;
  app.observeHistory(history, incomplete, method('percentage'), {}, { at: first + 2, beforeCache: other });
  assert.deepEqual(events(history).at(-1).kinds, ['reconciliation']);
  assert.equal(events(history).at(-1).percentage, null);
  history.enabled = false;
  assert.equal(app.observeHistory(history, other, method('percentage'), {}, { at: first + 3 }), false);
  history.enabled = true;
  app.observeHistory(history, other, method('percentage'), {}, { at: first + 4, reset: true });
  assert.deepEqual(events(history).at(-1).kinds, ['reconciliation']);
  assert.deepEqual(app.historySeries(events(history)).map((item) => item.length), [1, 1]);
});

test('restart and grade-cache reset use persisted checkpoints without inventing assessment changes', () => {
  const cache = gradeCache();
  const history = JSON.parse(JSON.stringify(start(cache)));
  assert.equal(app.observeHistory(history, cache, method('percentage'), {}, { at: first + 1 }), false);
  const after = structuredClone(cache);
  after.clearedAt = first + 2;
  bucket(after).records = { a: paper('a', 8) };
  app.observeHistory(history, after, method('percentage'), {}, { at: first + 3 });
  assert.deepEqual(events(history).at(-1).kinds, ['reconciliation']);
  assert.equal(events(history).at(-1).percentage, 80);
});

test('history exports and optional backups validate and merge by scope without duplicates', () => {
  const cache = gradeCache();
  const history = start(cache);
  const next = structuredClone(cache);
  bucket(next).records.b = paper('b', 2, 'Exam');
  app.observeHistory(history, next, method('percentage'), {}, { at: first + 100, beforeCache: cache });
  const archive = app.archiveHistory(history, 'a'.repeat(64));
  const file = app.makeBackup({ school: 'uia.managebac.com', scope: { 123: ['71'] }, student: null });
  const normalized = app.readBackup(JSON.parse(JSON.stringify({ ...file, history: archive }))).history;
  assert.deepEqual(normalized, archive);
  assert.ok(!Object.hasOwn(normalized.terms[0], 'checkpoint'));
  assert.match(app.historyCSV(archive), /Chemistry,123,Semester 1,71,.*56,D,2,corrected-grade,-20/);
  const destination = app.emptyHistory();
  const unrelated = app.mergeHistory(destination, normalized, { 456: ['71'] });
  assert.equal(unrelated.added, 0);
  assert.equal(unrelated.skipped, 2);
  const merge = app.mergeHistory(destination, normalized, { 123: ['71'] });
  assert.equal(merge.added, 2);
  assert.equal(merge.history.enabled, false);
  assert.equal(app.mergeHistory(merge.history, normalized, { 123: ['71'] }).added, 0);
  merge.history.enabled = true;
  app.observeHistory(merge.history, next, method('percentage'), {}, { at: first + 120 });
  assert.equal(events(merge.history).length, 2);
  assert.equal(merge.history.terms[scope].checkpoint.id, events(merge.history).at(-1).id);
  assert.equal(app.readBackup(file).history, undefined);
  assert.throws(() => app.readHistoryArchive({ ...archive, version: 99 }), /unsupported/);
  archive.terms[0].events[1].delta = 20;
  assert.throws(() => app.readHistoryArchive(archive), /Invalid GradeLens history/);
});

test('retention preserves earliest start metadata and detects discarded observations', () => {
  let cache = gradeCache();
  const history = start(cache);
  const baselineId = events(history)[0].id;
  for (let i = 1; i <= 140; i++) {
    const next = structuredClone(cache);
    bucket(next).records.a.earnedPoints = i % 2 ? 9 : 8;
    app.observeHistory(history, next, method('percentage'), {}, { at: first + i, beforeCache: cache });
    cache = next;
  }
  assert.equal(events(history).length, 120);
  assert.equal(history.terms[scope].startedAt, first);
  assert.equal(history.terms[scope].dropped, 21);
  assert.ok(!events(history).some((event) => event.id === baselineId));
  assert.equal(events(history).at(-1).percentage, 76);
});
