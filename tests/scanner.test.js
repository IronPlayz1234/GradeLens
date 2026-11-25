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
  assert.equal(term.records['1'].earnedPoints, 10);
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
