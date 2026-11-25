const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { parseHTML } = require('linkedom');
require('../src/core/grades.js');
require('../src/core/cache.js');
require('../src/content/scanner.js');
const app = globalThis.MBGC;
const host = 'https://uia.managebac.com';
const tasksURL = new URL(host + '/student/classes/123/core_tasks');
const workspaceURL = new URL(host + '/student/tasks_and_deadlines?tab=past');
const fixture = (name) => parseHTML(fs.readFileSync(__dirname + '/fixtures/' + name + '.html', 'utf8')).document;

test('reads the class weights, selected term and valid scores on Pending tasks', () => {
  const doc = fixture('class-tasks');
  const snapshot = app.scan(doc, tasksURL);
  assert.equal(app.account(doc, tasksURL), '9');
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.term.id, '71');
  assert.deepEqual(snapshot.weights, { Coursework: 30, Research: 30, 'Semester Exam': 40 });
  assert.equal(snapshot.records.length, 4);
  assert.equal(snapshot.records[0].earnedPoints, 8);
  assert.equal(snapshot.records[0].status, 'Pending');
  assert.equal(snapshot.records[1].assessmentType, 'Formative');
});

test('deduplicates stable IDs in each term, keeps zero, and isolates unverified term and invalid scores', () => {
  const snapshot = app.scan(fixture('workspace'), workspaceURL);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.records.length, 4);
  const [zero, otherTerm, submitted, malformed] = snapshot.records;
  assert.equal(zero.earnedPoints, 0);
  assert.equal(otherTerm.termId, '72');
  assert.equal(submitted.classId, '456');
  assert.equal(submitted.status, 'Submitted');
  assert.equal(submitted.earnedPoints, null);
  assert.equal(malformed.termId, null);
  assert.ok(malformed.issue);
  assert.ok(snapshot.sources.includes('/student/tasks_and_deadlines?tab=past'));
  assert.ok(snapshot.sources.includes('/student/classes/456/core_tasks'));
});

test('conflicting records are flagged and filtered data cannot confirm completeness', () => {
  const doc = fixture('workspace');
  doc.querySelectorAll('.short-assignment .points')[1].textContent = '10 / 10';
  const [task] = app.scan(doc, workspaceURL).records;
  assert.equal(task.earnedPoints, null);
  assert.equal(task.issue, 'Conflicting assessment records');
  assert.equal(app.scan(fixture('class-tasks'), new URL(tasksURL + '?page=2')).complete, false);
});

test('auto-detects a displayed scale with explicit percentage ranges', () => {
  const doc = fixture('class-tasks');
  doc.querySelector('main').insertAdjacentHTML('beforeend', '<table id="task-grade-scale"><tr><td>A</td><td>80–100%</td></tr><tr><td>U</td><td>0–79%</td></tr></table>');
  assert.deepEqual(app.scan(doc, tasksURL).scale, [[80, 'A'], [0, 'U']]);
});

test('upserts changes, accepts new grades, preserves partial omissions, then removes confirmed deletions', () => {
  const doc = fixture('class-tasks');
  const cache = app.freshCache();
  const apply = (at) => app.mergeScan(cache, { ...app.scan(doc, tasksURL), at });
  apply(1);
  const term = cache.classes['123'].terms['term:71'];
  assert.equal(Object.keys(term.records).length, 4);
  doc.querySelector('#task-one .points').textContent = '10 / 10';
  const clone = doc.querySelector('#task-one').cloneNode(true);
  clone.querySelector('a').setAttribute('href', '/student/classes/123/core_tasks/5');
  doc.querySelector('[data-task-list]').append(clone);
  apply(2);
  assert.equal(term.records['1'].earnedPoints, 8);
  assert.equal(term.records['5'].earnedPoints, 10);
  doc.querySelector('#task-one').remove();
  doc.querySelector('[data-task-list]').setAttribute('data-total-count', '5');
  apply(3);
  assert.equal(Object.keys(term.records).length, 5);
  assert.equal(term.complete, false);
  doc.querySelector('[data-task-list]').setAttribute('data-total-count', '4');
  apply(4);
  assert.equal(Object.keys(term.records).length, 4);
  assert.equal(term.records['1'], undefined);
  assert.equal(term.complete, true);
  assert.equal(cache.lastSync, 4);
});

test('late partial responses cannot restore a task after a newer authoritative deletion', () => {
  const doc = fixture('class-tasks');
  const cache = app.freshCache();
  const initial = app.scan(doc, tasksURL);
  app.mergeScan(cache, { ...initial, at: 10 });
  doc.querySelector('#task-one').remove();
  doc.querySelector('[data-task-list]').setAttribute('data-total-count', '3');
  app.mergeScan(cache, { ...app.scan(doc, tasksURL), at: 30 });
  app.mergeScan(cache, { ...initial, at: 20, complete: false });
  assert.equal(cache.classes['123'].terms['term:71'].records['1'], undefined);
});

test('reads the screenshot-inspired task panel, dropdown link ID, score variants, and weight column', () => {
  const doc = fixture('desktop-integration');
  const snapshot = app.scan(doc, tasksURL);
  assert.deepEqual(snapshot.term, { id: '671', label: 'Semester 1 (current)' });
  assert.equal(app.account(doc, tasksURL), '9');
  assert.equal(app.taskSurface(doc).chart.textContent, 'Assessment');
  assert.deepEqual(snapshot.weights, { Coursework: 60, Research: 40 });
  assert.deepEqual(snapshot.records.map((item) => [item.id, item.termId, item.earnedPoints, item.maxPoints]),
    [['301', '671', 18, 20], ['303', '671', null, null], ['302', '671', 0, 10]]);
  assert.equal(snapshot.diagnostic.points, 2);
  assert.equal(snapshot.complete, false);
});

test('visible semester label alone cannot establish a term ID', () => {
  const doc = fixture('desktop-integration');
  doc.querySelector('#school-terms').remove();
  doc.querySelector('#term-results').removeAttribute('data-term-id');
  const snapshot = app.scan(doc, tasksURL);
  assert.equal(snapshot.term.id, null);
  assert.equal(snapshot.diagnostic.unassigned, 2);
  assert.ok(snapshot.records.every((item) => item.termId === null));
});

test('reads bracketed native selects and link-backed native option values', () => {
  const doc = fixture('desktop-integration');
  const select = '<select name="filters[academic_term_id]"><option value="671" selected>Semester 1 (current)</option></select>';
  doc.querySelector('.titlebar').innerHTML = '<div class="title">All Tasks</div>' + select;
  assert.deepEqual(app.scan(doc, tasksURL).term, { id: '671', label: 'Semester 1 (current)' });
  doc.querySelector('option').setAttribute('value', '/student/classes/123/core_tasks?class_term_id=672');
  assert.equal(app.scan(doc, tasksURL).term.id, '672');
});

test('distinguishes displayed letters without point values from pending tasks', () => {
  const doc = fixture('desktop-integration');
  doc.querySelector('.score-points').remove();
  doc.querySelector('[data-earned-points]').remove();
  const { diagnostic } = app.scan(doc, tasksURL);
  assert.equal(diagnostic.parsed, 3);
  assert.equal(diagnostic.points, 0);
  assert.equal(diagnostic.scoreIssues, 2);
});

test('reads a portaled native term menu and retains verified evidence when that control closes', () => {
  const doc = fixture('desktop-integration');
  const menu = doc.querySelector('#school-terms');
  doc.body.append(menu);
  assert.equal(app.scan(doc, tasksURL).term.id, '671');
  menu.remove();
  assert.equal(app.scan(doc, tasksURL).term.id, '671');
  doc.querySelector('[role="combobox"]').textContent = 'Semester 2';
  assert.equal(app.scan(doc, tasksURL).term.id, null);
});

test('discover enrolled roster pages and real term form links without scheduling school catalog or foreign links', () => {
  const doc = parseHTML(`<html><body><nav>
    <a href="/student/classes">My Classes</a><a href="/student/classes?tab=all">Browse All Classes</a>
    <a href="/student/classes?tab=my_classes&amp;page=2" rel="next">Next</a>
    <select><option value="/student/classes/44">PE</option></select>
    <a href="https://other.invalid/student/classes/46">Foreign</a></nav>
    <a href="/student/classes/55">Mathematics</a></body></html>`).document;
  const roster = new URL(host + '/student/classes');
  const snapshot = app.scan(doc, roster);
  assert.deepEqual(snapshot.classes, { 44: 'PE', 55: 'Mathematics' });
  assert.ok(snapshot.sources.includes('/student/classes?tab=my_classes&page=2'));
  assert.ok(snapshot.sources.includes('/student/classes/44/core_tasks'));
  assert.equal(app.sourceURL('/student/classes?tab=all', roster), null);
  assert.deepEqual(app.scan(doc, new URL(roster + '?tab=all')).classes, {});
  const classDoc = fixture('class-tasks');
  const term = classDoc.querySelector('select[name="term_id"]');
  const form = classDoc.createElement('form');
  term.before(form);
  form.setAttribute('action', tasksURL.pathname);
  form.append(term);
  assert.ok(app.scan(classDoc, tasksURL).sources.includes(tasksURL.pathname + '?term_id=72'));
  form.setAttribute('method', 'post');
  assert.ok(!app.scan(classDoc, tasksURL).sources.includes(tasksURL.pathname + '?term_id=72'));
});

test('PE uses its own cached term and retains points and weights on partial or empty background reads', () => {
  const doc = fixture('class-tasks');
  const cache = app.freshCache();
  const source = app.scan(doc, tasksURL);
  const pe = { ...source, classes: { 123: 'Physical Education AS' }, records: source.records.slice(0, 2).map((record, index) => ({
    ...record, title: ['Push Ups', '1 mile run'][index], earnedPoints: 100, maxPoints: 100
  })), visible: true, at: 10 };
  app.mergeScan(cache, pe);
  const read = () => {
    const subject = cache.classes['123'];
    const bucket = subject.terms[app.classTermKey(subject)];
    return app.calculate(Object.values(bucket.records), bucket.weights);
  };
  assert.equal(read().percentage, 100);
  app.mergeScan(cache, { ...pe, term: { id: '8', label: 'Semester 1' },
    defaultTerm: true, visible: false, at: 20, records: [], complete: false, weights: {} });
  app.mergeScan(cache, { ...pe, defaultTerm: true, visible: false, at: 30, records: [], weights: {} });
  app.mergeScan(cache, { ...pe, visible: false, at: 32, complete: false,
    records: [{ ...pe.records[0], earnedPoints: null, maxPoints: 100, explicitlyUngraded: true }], weights: {} });
  assert.equal(read().count, 2);
  assert.equal(read().percentage, 100);
  assert.equal(cache.classes['123'].terms['term:71'].lastScan, 10);
});

test('explicit grade eligibility and graded state are independent of submission status', () => {
  const doc = fixture('class-tasks');
  doc.querySelector('#task-one [class*="assessment-cell"]').setAttribute('data-graded', 'false');
  doc.querySelectorAll('.short-assignment')[1].setAttribute('data-counts-toward-grade', 'false');
  const snapshot = app.scan(doc, tasksURL);
  assert.equal(snapshot.records[0].earnedPoints, null);
  assert.equal(snapshot.records[0].explicitlyUngraded, true);
  assert.equal(snapshot.records[1].excluded, true);
  assert.equal(app.calculate(snapshot.records, snapshot.weights).count, 2);
});

test('discovers and calculates a mixed roster from class-specific point evidence and grading categories', () => {
  const { subjects, tasksPath, tasksPage, rosterPage } = require('./fixtures/subjects');
  const roster = app.scan(parseHTML(rosterPage()).document, new URL(host + '/student/classes'));
  const cache = app.freshCache();
  app.mergeScan(cache, roster);
  for (const subject of subjects) {
    const path = tasksPath(subject);
    assert.ok(roster.sources.includes(path), subject.name);
    assert.equal(roster.classes[subject.id], subject.name);
    const scan = app.scan(parseHTML(tasksPage(subject)).document, new URL(host + path));
    assert.deepEqual(scan.weights, Object.fromEntries(subject.categories), subject.name);
    assert.deepEqual(scan.records.map((task) => task.gradeKind), subject.kinds, subject.name);
    assert.ok(scan.records.every((task) => task.classId === subject.id), subject.name);
    app.mergeScan(cache, { ...scan, defaultTerm: true });
    const stored = cache.classes[subject.id];
    const bucket = stored.terms[app.classTermKey(stored)];
    for (const [method, expected] of Object.entries(subject.grades)) {
      const { percentage } = app.calculate(Object.values(bucket.records), bucket.weights, method);
      if (expected === null) assert.equal(percentage, null, subject.name + ' ' + method);
      else assert.ok(Math.abs(percentage - expected) < 1e-9, subject.name + ' ' + method + ': ' + percentage);
    }
  }
});

test('five class caches survive incomplete alternate terms and failures; only a confirmed change replaces points', () => {
  const cache = app.freshCache();
  const names = ['Chemistry', 'Physical Education AS', 'Mathematics', 'Physics', 'Computer Science'];
  const scores = [33.05, 100, 92, 86, 89];
  const snapshot = (index, at, points = scores[index], options = {}) => {
    const classId = String(660 + index);
    const termId = options.termId ?? 'school-' + index;
    return { classes: { [classId]: names[index] }, context: { classId, type: 'tasks' },
      term: { id: termId, label: options.label ?? 'Semester 1' },
      records: [{ id: '1', classId, termId, category: 'Coursework', earnedPoints: points, maxPoints: 100 }],
      weights: { Coursework: 100 }, sources: [], at, complete: true, defaultTerm: true, ...options };
  };
  const percentages = () => names.map((_, index) => {
    const subject = cache.classes[String(660 + index)];
    const bucket = subject.terms[app.classTermKey(subject)];
    return app.calculate(Object.values(bucket.records), bucket.weights).percentage;
  });
  names.forEach((_, index) => app.mergeScan(cache, snapshot(index, 10)));
  app.mergeScan(cache, snapshot(2, 21, null, { termId: 'shell-999', complete: false, weights: {} }));
  app.mergeScan(cache, snapshot(2, 22, 25, { complete: false, weights: { Coursework: 15 } }));
  app.mergeCheck(cache, { source: '/student/classes/662/core_tasks', classId: '662', at: 25, error: 'HTML did not expose grades.' });
  assert.deepEqual(percentages(), scores);
  assert.equal(cache.classes['662'].terms['term:school-2'].lastScan, 10);
  assert.equal(cache.classes['662'].terms['term:school-2'].weights.Coursework, 100);
  app.mergeScan(cache, snapshot(2, 35, 94));
  app.mergeScan(cache, snapshot(2, 32, 40));
  assert.deepEqual(percentages(), [33.05, 100, 94, 86, 89]);
});

test('task detail extracts an explicit result for the linked class, term and assessment only', () => {
  const known = {
    id: '48', classId: '123', termId: '71', category: 'Projects', title: 'Coursework',
    earnedPoints: null, maxPoints: null, gradeKind: 'letter',
    taskUrl: tasksURL.pathname + '/48'
  };
  const detailUrl = new URL(tasksURL + '/48');
  const doc = parseHTML('<html><body><main><div data-assessment-result><span class="points">17 / 25</span></div></main></body></html>').document;
  const snapshot = app.scanTaskDetail(doc, detailUrl, known);
  assert.equal(snapshot.records[0].earnedPoints, 17);
  assert.equal(snapshot.records[0].maxPoints, 25);
  assert.equal(snapshot.records[0].category, 'Projects');
  assert.equal(app.scanTaskDetail(doc, new URL(tasksURL + '/49'), known), null);
  doc.querySelector('[data-assessment-result]').setAttribute('data-term-id', '72');
  assert.equal(app.scanTaskDetail(doc, detailUrl, known), null);
});

test('restores the term on an asynchronously populated select and an identified term trigger', () => {
  const doc = fixture('desktop-integration');
  const header = doc.querySelector('.titlebar');
  header.innerHTML = '<div class="title">All Tasks</div><select data-selected-term-id="671"></select>';
  assert.equal(app.scan(doc, tasksURL).term.id, '671');
  header.innerHTML = '<div class="title">All Tasks</div><button role="combobox" data-semester-id="671">Semester 1 (current)</button>';
  assert.deepEqual(app.scan(doc, tasksURL).term, { id: '671', label: 'Semester 1 (current)' });
});

test('a missing task identifier cannot confirm removal and a rendered correction can update its own row', () => {
  const doc = fixture('class-tasks');
  const cache = app.freshCache();
  const apply = (at) => app.mergeScan(cache, { ...app.scan(doc, tasksURL), visible: true, at });
  apply(10);
  doc.querySelector('#task-one .points').textContent = '9 / 10';
  doc.querySelectorAll('.short-assignment')[1].querySelector('a').removeAttribute('href');
  apply(12);
  const bucket = cache.classes['123'].terms['term:71'];
  assert.equal(bucket.complete, false);
  assert.equal(bucket.records['1'].earnedPoints, 9);
  assert.equal(bucket.records['2'].earnedPoints, 15);
  assert.equal(bucket.gradedCount, 4);
});

test('an empty unattended rendered list cannot delete saved grades', () => {
  const doc = fixture('class-tasks');
  const cache = app.freshCache();
  app.mergeScan(cache, { ...app.scan(doc, tasksURL), visible: true, at: 1 });
  const list = doc.querySelector('[data-task-list]');
  list.replaceChildren();
  list.setAttribute('data-total-count', '0');
  app.mergeScan(cache, { ...app.scan(doc, tasksURL), sourceKind: 'rendered', at: 2 });
  assert.equal(cache.classes['123'].terms['term:71'].gradedCount, 4);
});

test('uses explicit class-scoped assessment IDs when a row has no task link', () => {
  const doc = fixture('class-tasks');
  const row = doc.querySelector('#task-one');
  row.setAttribute('data-assessment-id', '551');
  assert.equal(app.scan(doc, tasksURL).records.length, 3);
  row.querySelector('a').remove();
  const task = app.scan(doc, tasksURL).records.find((item) => item.id === '551');
  assert.equal(task.earnedPoints, 8);
  assert.equal(task.taskUrl, null);
  row.setAttribute('data-class-id', '999');
  assert.equal(app.scan(doc, tasksURL).records.length, 3);
});

test('document-only grade views recalculate after an in-place cache update', () => {
  require('../src/ui/views.js');
  const doc = fixture('class-tasks');
  const sync = { cache: app.freshCache(), settings: app.settingsDefaults, overrides: { weights: {} } };
  const apply = (at) => app.mergeScan(sync.cache, { ...app.scan(doc, tasksURL), visible: true, at });
  apply(1);
  const first = app.gradeData(sync, '123', 'term:71');
  doc.querySelector('#task-one .points').textContent = '9 / 10';
  const updated = app.scan(doc, tasksURL);
  app.mergeScan(sync.cache, { ...updated, records: [updated.records[0]], incremental: true, visible: true, at: 2 });
  assert.equal(first.result.percentage, 74.5);
  assert.equal(app.gradeData(sync, '123', 'term:71').result.percentage, 76);
});

test('uses self-profile links in account menus and requires unambiguous identity', () => {
  const doc = fixture('class-tasks');
  const link = doc.querySelector('header a');
  doc.querySelector('main').append(link);
  assert.equal(app.account(doc, tasksURL), null);
  assert.equal(app.accountEvidence(doc, tasksURL).status, 'missing');
  const menu = doc.createElement('div');
  menu.setAttribute('role', 'menu');
  menu.append(link);
  doc.body.append(menu);
  assert.equal(app.account(doc, tasksURL), '9');
  link.setAttribute('href', '/student/profile');
  assert.equal(app.accountEvidence(doc, tasksURL).status, 'profile-without-id');
  link.setAttribute('href', '/student/profile/9');
  doc.body.setAttribute('data-current-student-id', '11');
  assert.equal(app.account(doc, tasksURL), null);
  assert.equal(app.accountEvidence(doc, tasksURL).status, 'conflicting');
});

test('background parser identifies a still-rendered previous term under the new selector', () => {
  const doc = fixture('class-tasks');
  doc.querySelector('option[selected]').setAttribute('value', '72');
  const snapshot = app.scan(doc, tasksURL);
  assert.equal(snapshot.term.id, '72');
  assert.equal(snapshot.diagnostic.loading, true);
  assert.equal(snapshot.complete, false);
});
