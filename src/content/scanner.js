(() => {
  const app = globalThis.MBGC;
  const classPattern = /^\/student\/classes\/(\d+)(?:\/(core_tasks)(?:\/(\d+))?)?\/?$/;
  const studentPath = (path) => path === '/student' || path.startsWith('/student/');
  const workspacePath = '/student/tasks_and_deadlines';
  const selectors = {
    tasks: '.short-assignment',
    term: 'select[name="term_id"], select[name="term"], select[name="academic_term_id"], select[name="semester_id"], select[name="semester"], select#term_id, select#academic_term_id, select#semester_id, [data-selected-term-id]',
    pagination: '.pagination, [rel="next"], [data-load-more], [aria-busy="true"], [data-loading="true"]',
    weights: '#categories-table',
    scale: '#task-grade-scale, #task_grade_scale, [data-task-grade-scale]'
  };
  const clean = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
  const txt = (node) => clean(node?.textContent);
  const numeric = (value) => /^\d+(?:\.\d+)?$/.test(clean(value)) ? Number(value) : null;
  const firstText = (root, selector) => txt(root.querySelector(selector));
  const id = (value) => /^[\w.-]{1,80}$/.test(value ?? '') && !['all', 'unknown', '0', '-1', 'default'].includes(value.toLowerCase()) ? value : null;

  function localURL(raw, base) {
    try {
      if (!raw || /^[#?]$/.test(raw)) return null;
      const url = new URL(raw, base);
      return url.origin === new URL(base).origin && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  function route(url) {
    const match = url.pathname.match(classPattern);
    if (match) return { classId: match[1], type: match[3] ? 'task' : match[2] ? 'tasks' : 'overview' };
    if (url.pathname.replace(/\/$/, '') === workspacePath) return { type: 'workspace' };
    return { type: 'other' };
  }

  function pageTerm(doc, url) {
    const control = doc.querySelector(selectors.term);
    const option = control?.options?.[control.selectedIndex] ??
      control?.querySelector('option[selected]') ?? control?.querySelector('option');
    const query = ['term_id', 'academic_term_id', 'semester_id'].map((name) => url.searchParams.get(name)).find(Boolean);
    const termId = id(control?.getAttribute('data-selected-term-id') || control?.value || option?.value || query);
    const label = txt(option) || clean(control?.getAttribute('data-term-label'));
    return { id: termId, label: termId ? label || `Term ${termId}` : 'Unidentified term' };
  }

  function account(doc, url) {
    const links = doc.querySelectorAll('header a[href], nav a[href], [role="banner"] a[href], [data-account-menu] a[href]');
    const ids = new Set();
    for (const marker of doc.querySelectorAll('header [data-current-student-id], [role="banner"] [data-current-student-id], [data-account-menu][data-current-student-id]')) {
      const value = marker.getAttribute('data-current-student-id');
      if (/^\d+$/.test(value)) ids.add(value);
    }
    for (const link of links) {
      const destination = localURL(link.getAttribute('href'), url);
      const match = destination?.pathname.match(/^\/student\/(?:profiles?|students)\/(\d+)(?:\/edit)?\/?$/);
      const purpose = [txt(link), link.getAttribute('aria-label'), link.getAttribute('title')].filter(Boolean).join(' ');
      if (match && /\b(my profile|manage (?:your )?profile|edit (?:my |your )?profile)\b/i.test(purpose)) ids.add(match[1]);
    }
    return ids.size === 1 ? [...ids][0] : null;
  }

  function readWeights(doc) {
    const table = doc.querySelector(selectors.weights);
    if (!table) return {};
    const weights = new Map();
    for (const row of table.querySelectorAll('.list-item:not(.list-item-head), tr')) {
      const cells = row.querySelectorAll(':scope > .cell, :scope > td');
      const category = firstText(row, '.label') || txt(cells[0]);
      const value = numeric(txt(cells[1]).replace(/\s*%$/, ''));
      if (!category || !app.validWeight(value)) continue;
      const key = app.key(category);
      const previous = weights.get(key);
      weights.set(key, previous && previous[1] !== value ? [category, null] : [category, value]);
    }
    return Object.fromEntries([...weights.values()].filter(([, value]) => value !== null));
  }

  function readScale(doc) {
    const table = doc.querySelector(selectors.scale);
    if (!table) return null;
    const rows = [];
    for (const row of table.querySelectorAll('tr, .list-item:not(.list-item-head)')) {
      const cells = [...row.querySelectorAll(':scope > td, :scope > .cell')].map(txt);
      const grade = cells.find((cell) => /^[A-Z][*+−-]?$/.test(cell));
      const threshold = cells.find((cell) => /^\d+(?:\.\d+)?\s*%$/.test(cell));
      if (grade && threshold) rows.push([numeric(threshold.replace('%', '')), grade]);
      else {
        const range = cells.join(' ').match(/(\d+(?:\.\d+)?)\s*%?\s*[-–—]\s*\d+(?:\.\d+)?\s*%/);
        if (grade && range) rows.push([Number(range[1]), grade]);
      }
    }
    return app.normalizeScale(rows);
  }

  function discover(doc, url) {
    const sources = new Map();
    const classes = {};
    for (const link of doc.querySelectorAll('a[href]')) {
      if (link.closest('.mbgc-owned')) continue;
      const destination = localURL(link.getAttribute('href'), url);
      if (!destination) continue;
      const location = route(destination);
      if (location.classId && location.type !== 'task') {
        const path = `/student/classes/${location.classId}/core_tasks`;
        if (location.type === 'tasks') {
          for (const name of ['term_id', 'academic_term_id', 'semester_id']) {
            const value = id(destination.searchParams.get(name));
            if (value) sources.set(`${path}?${name}=${encodeURIComponent(value)}`, true);
          }
        }
        sources.set(path, true);
        const label = txt(link);
        if (location.type === 'overview' && label && !/^(overview|class|back)$/i.test(label)) classes[location.classId] = label;
      }
      if (location.type === 'workspace') {
        // Preserve only a student-visible, link-backed Past filter.
        if (/^past$/i.test(txt(link))) {
          const params = new URLSearchParams();
          for (const [name, value] of destination.searchParams) {
            if (['tab', 'view', 'filter', 'period', 'timeframe', 'status', 'type'].includes(name) && /^past$/i.test(value)) {
              params.set(name, value);
            }
          }
          if (params.size) sources.set(`${workspacePath}?${params}`, true);
        } else {
          sources.set(workspacePath, true);
        }
      }
    }
    const current = route(url);
    if (current.classId) {
      const path = `/student/classes/${current.classId}/core_tasks`;
      sources.set(path, true);
      if (current.type === 'tasks') {
        for (const name of ['term_id', 'academic_term_id', 'semester_id']) {
          const value = id(url.searchParams.get(name));
          if (value) sources.set(`${path}?${name}=${encodeURIComponent(value)}`, true);
        }
      }
    }
    return { sources: [...sources.keys()], classes };
  }

  function readTask(node, url, context, term, classes, weights) {
    const link = node.querySelector('.h4.title a[href], .title a[href]');
    const destination = localURL(link?.getAttribute('href'), url);
    const match = destination?.pathname.match(classPattern);
    if (!match?.[3] || (context.classId && context.classId !== match[1])) return null;

    const classId = match[1];
    const termId = id(node.getAttribute('data-term-id') || node.getAttribute('data-academic-term-id')) ||
      (context.type === 'tasks' ? term.id : null);
    const labels = [...node.querySelectorAll('.labels-set .label')]
      .filter((label) => !label.closest('.assessment-cell')).map(txt).filter(Boolean);
    const assessmentType = labels.find((label) => /^(formative|summative)$/i.test(label)) ?? '';
    const subject = clean(node.getAttribute('data-subject')) ||
      firstText(node, '.class-name, .subject-name, [data-class-name] a, a[href$="/classes/' + classId + '"]') ||
      classes[classId] || '';
    const categories = [...new Set(labels.filter((label) => label !== assessmentType && app.key(label) !== app.key(subject)))];
    const recognized = categories.filter((label) => Object.keys(weights).some((name) => app.key(name) === app.key(label)));
    const explicitCategory = clean(node.getAttribute('data-category')) || firstText(node, '.assessment-category, .task-category');
    const category = explicitCategory || (recognized.length === 1 ? recognized[0] : categories.length === 1 ? categories[0] : '');
    const score = node.querySelector('.assessment-cell');
    const points = [...(score?.querySelectorAll('.points') ?? [])].map(txt).filter(Boolean);
    const parsed = points.map((value) => value.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(?:pts?\.?|points?)?$/i));
    const first = parsed[0];
    const scoreMatch = first && parsed.every((match) => match &&
      Number(match[1]) === Number(first[1]) && Number(match[2]) === Number(first[2])) ? first : null;
    const result = {
      id: match[3], classId, subject, termId, category, assessmentType,
      title: txt(link) || `Assessment ${match[3]}`,
      earnedPoints: scoreMatch ? Number(scoreMatch[1]) : null,
      maxPoints: scoreMatch ? Number(scoreMatch[2]) : null,
      displayedLetter: firstText(score ?? node, '.grade'),
      status: firstText(node, '.submission-status, .task-status') ||
        (txt(score).match(/\b(not submitted|submitted|pending|ungraded)\b/i)?.[0] ?? ''),
      taskUrl: destination.pathname,
      issue: null
    };
    if (!app.validScore(result)) {
      if (points.length || /^[A-Z][*+-]?$/.test(result.displayedLetter)) result.issue = 'Points unavailable or invalid';
      result.earnedPoints = null;
      result.maxPoints = null;
    } else if (!category) {
      result.issue = 'Category unavailable or ambiguous';
    }
    return result;
  }

  function scan(doc, url) {
    const context = route(url);
    const term = pageTerm(doc, url);
    const found = discover(doc, url);
    const weights = readWeights(doc);
    const scale = readScale(doc);
    const records = new Map();
    const nodes = context.type === 'tasks' || context.type === 'workspace'
      ? [...doc.querySelectorAll(selectors.tasks)]
      : [];
    if (context.classId) {
      const title = firstText(doc, '.class-title, [data-class-title], .class-name') ||
        (context.type === 'overview' ? firstText(doc, 'main h1, [role="main"] h1') : '');
      if (title) found.classes[context.classId] = title;
    }
    for (const node of nodes) {
      if (node.hidden || node.closest('[hidden], [aria-hidden="true"], template, .mbgc-owned')) continue;
      const task = readTask(node, url, context, term, found.classes, weights);
      if (!task) continue;
      const key = JSON.stringify([task.classId, task.termId, task.id]);
      const previous = records.get(key);
      if (previous && app.validScore(previous) && app.validScore(task) &&
        (previous.earnedPoints !== task.earnedPoints || previous.maxPoints !== task.maxPoints ||
          (previous.category && task.category && app.key(previous.category) !== app.key(task.category)))) {
        records.set(key, { ...task, earnedPoints: null, maxPoints: null, issue: 'Conflicting assessment records' });
      } else if (!previous || (previous.issue !== 'Conflicting assessment records' && app.validScore(task))) {
        records.set(key, previous ? { ...task, subject: task.subject || previous.subject,
          assessmentType: task.assessmentType || previous.assessmentType, category: task.category || previous.category,
          displayedLetter: task.displayedLetter || previous.displayedLetter, status: task.status || previous.status } : task);
      }
      if (task.subject && !found.classes[task.classId]) found.classes[task.classId] = task.subject;
    }
    for (const task of records.values()) {
      if (!task.subject) task.subject = found.classes[task.classId] || '';
      if (!found.sources.includes(`/student/classes/${task.classId}/core_tasks`)) {
        found.sources.push(`/student/classes/${task.classId}/core_tasks`);
      }
    }

    // An explicit total on an unfiltered, term-scoped list is required before absence implies deletion.
    const list = doc.querySelector('[data-total-count][data-term-id][data-task-list="all"]');
    const total = numeric(list?.getAttribute('data-total-count'));
    const complete = context.type === 'tasks' && Boolean(term.id && list) && total !== null &&
      list.getAttribute('data-term-id') === term.id &&
      nodes.every((node) => list.contains(node)) &&
      [...records.values()].every((task) => task.termId === term.id && !task.issue) &&
      total === nodes.length && total === records.size &&
      !(list.closest('[data-all-tasks], #all-tasks, #all_tasks, section') ?? list).querySelector(selectors.pagination) && !list.matches(selectors.pagination) &&
      [...url.searchParams.keys()].every((name) => ['term_id', 'academic_term_id', 'semester_id'].includes(name));

    return {
      ...found, context, term, weights, scale, records: [...records.values()], complete,
      readable: Boolean(records.size || complete || Object.keys(weights).length || scale),
      at: Date.now()
    };
  }

  Object.assign(app, { selectors, clean, numeric, localURL, route, pageTerm, account, scan, workspacePath, studentPath });
})();
