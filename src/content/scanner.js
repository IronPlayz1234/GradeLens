(() => {
  const app = globalThis.MBGC;
  const classPattern = /^\/student\/classes\/(\d+)(?:\/(core_tasks|tasks)(?:\/(\d+))?)?\/?$/;
  const studentPath = (path) => path === '/student' || path.startsWith('/student/');
  const rosterPattern = /^\/student\/(?:classes|my_classes)\/?$/;
  const workspacePath = '/student/tasks_and_deadlines';
  const termParams = ['term_id', 'academic_term_id', 'semester_id', 'reporting_period_id', 'term', 'semester'];
  const headingSelector = 'h1,h2,h3,h4,h5,[role="heading"],.h2,.h3,.h4,.section-title,.panel-title,.card-title,div,span,strong';
  const selectors = {
    tasks: '.short-assignment, .task-card, .assignment-card, .assessment-card, [data-task-id], [data-assignment-id], [data-assessment-id]',
    score: '.assessment-cell, .task-score, .assessment-score, [data-task-score], [data-assessment-score]',
    letter: '.grade, .letter-grade, [data-letter-grade]',
    rubric: '[data-rubric], .rubric, .assessment-rubric, [data-criterion], [data-criterion-id], .rubric-criterion',
    points: '.points, .score-points, .marks, [data-earned-points], [data-max-points]',
    termControls: 'select, [role="combobox"], [aria-haspopup], [data-selected-term-id], [data-term-id][aria-selected], [data-semester-id][aria-selected]',
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
      return url.origin === (base instanceof URL ? base.origin : new URL(base).origin) && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  function route(url) {
    const match = url.pathname.match(classPattern);
    if (match) return { classId: match[1], taskId: match[3], type: match[3] ? 'task' : match[2] ? 'tasks' : 'overview' };
    if (rosterPattern.test(url.pathname)) return { type: 'roster' };
    if (url.pathname.replace(/\/$/, '') === workspacePath) return { type: 'workspace' };
    return { type: 'other' };
  }

  const exposed = (node) => !node?.closest('[hidden], [aria-hidden="true"], template, .mbgc-owned');

  function heading(root, pattern) {
    return [...root.querySelectorAll(headingSelector)].find((node) => node.childElementCount <= 6 && exposed(node) &&
      pattern.test(txt(node)) && ![...node.children].some((child) => child.matches(headingSelector) && pattern.test(txt(child)))) ?? null;
  }

  function taskSurface(doc) {
    const title = heading(doc, /^all tasks$/i);
    if (!title) return {};
    const marked = title.closest('[data-all-tasks],#all-tasks,#all_tasks');
    let section = marked || title.parentElement;
    let chart;
    for (let box = section; box && !box.matches('body,html'); box = box.parentElement) {
      const candidate = heading(box, /^(overall task completion|grade distribution|assessment)$/i);
      if (candidate && !(title.compareDocumentPosition(candidate) & 2)) {
        section = box;
        chart = candidate;
        break;
      }
      if (!marked && box.matches('section,article,.section,.panel,.card')) section = box;
      if (marked || box.matches('main,[role="main"]')) break;
    }
    return { title, section, chart };
  }

  function termFromURL(url) {
    for (const [name, value] of url.searchParams) {
      if (isTermField(name) && id(value)) return { name, id: id(value) };
    }
    return null;
  }

  function isTermField(name) {
    const parts = String(name ?? '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z_]+/);
    return parts.some((part) => termParams.includes(part) || ['terms', 'academic_term', 'class_term_id', 'school_term_id'].includes(part));
  }

  const verifiedMenus = new WeakMap();
  const termLabel = /\b(?:semester|trimester|term|quarter)\b/i;
  const stableOption = (value) => /^\d+$|^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value ?? '') ? id(value) : null;

  function pageTerm(doc, url, surface = {}) {
    const context = route(url);
    const query = termFromURL(url);
    const find = (scope, scoped) => {
      if (!scope) return null;
      const results = [];
      const accept = (termId, label) => {
        if (termId) results.push({ id: termId, label: label || 'Selected academic term' });
      };
      for (const control of scope.querySelectorAll('select, ' + selectors.term)) {
        if (!exposed(control) && control.tagName !== 'SELECT') continue;
        if (control.tagName === 'SELECT') {
          const option = control.options?.[control.selectedIndex] ??
            control.querySelector('option[selected]') ?? control.querySelector('option');
          if (!option) {
            accept(id(control.getAttribute('data-selected-term-id')), control.getAttribute('data-term-label'));
            continue;
          }
          const declared = control.matches(selectors.term) || isTermField(control.name || control.getAttribute('name')) ||
            isTermField(control.id) || termLabel.test([control.getAttribute('aria-label'), control.closest('label')?.textContent].join(' '));
          const value = option.getAttribute('value');
          const optionURL = localURL(value, url);
          const linked = optionURL && route(optionURL).classId === context.classId && route(optionURL).type === 'tasks'
            ? termFromURL(optionURL)?.id : null;
          if (declared || (scoped && termLabel.test(txt(option)))) {
            accept(id(option.getAttribute('data-term-id')) || linked || (declared ? id(value) : stableOption(value)) ||
              id(control.getAttribute('data-selected-term-id')), txt(option));
          }
        } else {
          accept(id(control.getAttribute('data-selected-term-id')),
            clean(control.getAttribute('data-term-label')) || txt(control));
        }
      }
      if (scoped) {
        const optionSelector = 'a[href], [role="option"], [role="menuitem"], [data-term-id], [data-semester-id]';
        const choices = new Set(scope.querySelectorAll(optionSelector));
        const triggers = [...scope.querySelectorAll('[role="combobox"],button,[role="button"],.dropdown-toggle')]
          .filter((node) => exposed(node) && termLabel.test(txt(node)));
        for (const trigger of triggers) {
          accept(id(trigger.getAttribute('data-term-id') || trigger.getAttribute('data-semester-id')), txt(trigger));
        }
        for (const input of scope.querySelectorAll('form input[type="hidden"][name]')) {
          const form = input.closest('form');
          const action = localURL(form.getAttribute('action') || url.href, url);
          if (action && route(action).type === 'tasks' && route(action).classId === context.classId &&
            /^get$/i.test(form.getAttribute('method') || 'get') && isTermField(input.name || input.getAttribute('name'))) {
            accept(id(input.getAttribute('value')), triggers.length === 1 ? txt(triggers[0]) : '');
          }
        }
        const menus = new Map(triggers.map((trigger) => [trigger, doc.getElementById(trigger.getAttribute('aria-controls') || '')]));
        for (const menu of menus.values()) {
          for (const choice of menu?.querySelectorAll(optionSelector) ?? []) choices.add(choice);
        }
        const page = url.pathname + url.search;
        const matches = new Map();
        for (const choice of choices) {
          const label = txt(choice);
          if (!termLabel.test(label) || choice.closest('.mbgc-owned, template')) continue;
          const selected = choice.matches('[aria-selected="true"],[aria-current="true"],[aria-current="page"],[data-selected="true"],.active,.selected') ||
            choice.parentElement?.matches('li.active,li.selected');
          const matching = triggers.filter((trigger) => label === txt(trigger) &&
            (trigger.hasAttribute('aria-controls') ? menus.get(trigger)?.contains(choice) : !trigger.contains(choice)));
          if (!selected && !matching.length) continue;
          const target = localURL(choice.getAttribute('href'), url);
          const sameClass = target && (!context.classId || route(target).classId === context.classId) &&
            ['tasks', 'workspace'].includes(route(target).type);
          const termId = id(choice.getAttribute('data-term-id') || choice.getAttribute('data-semester-id')) ||
            (sameClass ? termFromURL(target)?.id : null) ||
            (choice.matches('[role="option"],[role="menuitem"]') ? stableOption(choice.getAttribute('data-value')) : null);
          accept(termId, label);
          if (!termId) continue;
          for (const trigger of matching) {
            if (!matches.has(trigger)) matches.set(trigger, new Set());
            matches.get(trigger).add(termId);
          }
        }
        const observedIds = new Set(results.map((term) => term.id));
        for (const trigger of triggers) {
          const label = txt(trigger);
          const known = verifiedMenus.get(trigger);
          const matched = matches.get(trigger);
          if (matched?.size === 1 && observedIds.size === 1) {
            verifiedMenus.set(trigger, { id: [...matched][0], page, label });
          } else if (results.length || matched?.size || known?.page !== page || known?.label !== label) {
            verifiedMenus.delete(trigger);
          } else if (!menus.get(trigger)) {
            // Some controls unmount their options on close. Reuse evidence only for the same live control.
            accept(known.id, label);
          }
        }
      }
      if (new Set(results.map((term) => term.id)).size !== 1) return null;
      return results.find((term) => termLabel.test(term.label)) ?? results[0];
    };
    const fromControl = find(surface.section, true) || find(doc, false);
    if (fromControl) return fromControl;
    if (query) return { id: query.id, label: 'Selected academic term' };
    if (context.type === 'tasks' && surface.section && !surface.section.querySelector(selectors.termControls)) {
      const lists = [...surface.section.querySelectorAll('[data-task-list="all"][data-term-id]')].filter(exposed);
      const ids = new Set(lists.map((list) => id(list.getAttribute('data-term-id'))));
      if (ids.size === 1 && !ids.has(null)) return { id: [...ids][0], label: 'Selected academic term' };
    }
    return { id: null, label: 'Unidentified term' };
  }

  const accountNavigationLinks = 'header a[href],nav a[href],[role="banner"] a[href],[data-account-menu] a[href],aside a[href],[role="menu"] a[href],.dropdown-menu a[href]';
  const accountLinks = 'a[href*="/student/profile"],a[href*="/student/students/"],[data-account-menu]';
  const selfProfileLabel = /\b(my profile|manage (?:your )?profile|edit (?:my |your )?profile)\b/i;

  function selfProfile(doc, url) {
    return [...doc.querySelectorAll('a[href*="/student/profile"]')].some((link) => {
      const target = localURL(link.getAttribute('href'), url);
      return target?.pathname.replace(/\/$/, '') === '/student/profile' && !target.search &&
        [txt(link), link.getAttribute('aria-label'), link.getAttribute('title')]
          .some((label) => /^(my profile|manage your profile)$/i.test(clean(label)));
    });
  }

  function profileEmail(doc) {
    const emails = new Set();
    const accept = (raw) => {
      const value = clean(raw).toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) emails.add(value);
    };
    for (const field of doc?.querySelectorAll('input[type="email"], input[name$="[email]"], input[name="email"]') ?? []) {
      if (!field.closest('main,[role="main"],form') || field.closest('header,nav,aside,template')) continue;
      accept(field.getAttribute('value'));
    }
    for (const label of doc?.querySelectorAll('dt, th, label') ?? []) {
      if (label.closest('header,nav,aside,template') || !/^e-?mail(?: address)?:?$/i.test(txt(label))) continue;
      const value = label.nextElementSibling;
      if (value?.matches('dd,td,p,span,div')) accept(txt(value));
    }
    return emails.size === 1 ? [...emails][0] : null;
  }

  function accountEvidence(doc, url) {
    const ids = new Set();
    let profile = false;
    for (const meta of doc.querySelectorAll('meta[name="current-student-id"], meta[name="current-user-id"], meta[name="current_student_id"], meta[name="current_user_id"]')) {
      const value = meta.getAttribute('content');
      if (/^\d+$/.test(value)) ids.add(value);
    }
    for (const marker of doc.querySelectorAll('body[data-current-student-id], body[data-current-user-id], header [data-current-student-id], [role="banner"] [data-current-student-id], [data-account-menu][data-current-student-id], [data-account-menu][data-current-user-id]')) {
      const value = marker.getAttribute('data-current-student-id') || marker.getAttribute('data-current-user-id');
      if (/^\d+$/.test(value)) ids.add(value);
    }
    for (const link of doc.querySelectorAll(accountNavigationLinks)) {
      const purpose = [txt(link), link.getAttribute('aria-label'), link.getAttribute('title')].filter(Boolean).join(' ');
      if (!selfProfileLabel.test(purpose)) continue;
      const destination = localURL(link.getAttribute('href'), url);
      if (!destination) continue;
      profile = true;
      const match = destination.pathname.match(/^\/student\/(?:profiles?|students)\/(\d+)(?:\/edit)?\/?$/);
      if (match) ids.add(match[1]);
    }
    return { id: ids.size === 1 ? [...ids][0] : null,
      status: ids.size > 1 ? 'conflicting' : ids.size === 1 ? 'verified' : profile || selfProfile(doc, url) ? 'profile-without-id' : 'missing' };
  }

  const account = (doc, url) => accountEvidence(doc, url).id;

  function readWeights(doc) {
    const table = doc.querySelector(selectors.weights) ?? [...doc.querySelectorAll('table')].find((candidate) => {
      const headers = [...candidate.querySelectorAll('th')].map((cell) => app.key(txt(cell)));
      return headers.includes('category') && headers.some((label) => /^(?:category )?weight(?: \(%\))?$/.test(label));
    });
    if (!table) return {};
    const weights = new Map();
    const headers = [...table.querySelectorAll('thead th, tr:first-child th')].map((cell) => app.key(txt(cell)));
    const categoryIndex = headers.indexOf('category');
    const weightIndex = headers.findIndex((label) => /^(?:category )?weight(?: \(%\))?$/.test(label));
    for (const row of table.querySelectorAll('.list-item:not(.list-item-head), tr')) {
      const cells = row.querySelectorAll(':scope > .cell, :scope > td');
      const category = firstText(row, '.label') || txt(cells[categoryIndex < 0 ? 0 : categoryIndex]);
      const value = numeric(txt(cells[weightIndex < 0 ? 1 : weightIndex]).replace(/\s*%$/, ''));
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

  const discoveryLinks = 'a[href*="/student/classes"],a[href*="/student/my_classes"],a[href*="/student/tasks_and_deadlines"],a[rel="next"]';
  const assessmentLinks = 'a[href*="/core_tasks/"],a[href*="/tasks/"]';
  const enrolled = /^(?:my classes|enrolled classes|classes)$/i;
  const enrolledFilter = /^(?:my_classes|enrolled|joined)$/i;

  function sourceURL(raw, base) {
    const url = localURL(raw, base);
    if (!url) return null;
    const { type } = route(url);
    if (!['tasks', 'workspace', 'roster', 'task'].includes(type) || (type === 'task' && url.search)) return null;
    if (type === 'roster' && [...url.searchParams].some(([name, value]) =>
      !((name === 'page' && /^\d{1,4}$/.test(value)) || (['tab', 'view', 'filter'].includes(name) && enrolledFilter.test(value))))) return null;
    url.hash = '';
    return url;
  }

  function discover(doc, url, activeTerm) {
    const sources = new Map();
    const classes = {};
    const current = route(url);
    const isCurrentSelection = (target, termId) => current.type === 'tasks' && !url.search &&
      target.pathname === url.pathname && termId === activeTerm;
    const browsingCatalog = current.type === 'roster' && (!sourceURL(url, url) ||
      [...doc.querySelectorAll('[aria-current="page"],[aria-selected="true"],.active')].some((node) => /^browse all classes$/i.test(txt(node))));
    for (const link of doc.querySelectorAll(discoveryLinks)) {
      if (link.closest('.mbgc-owned')) continue;
      const href = link.getAttribute('href');
      if (/\/(?:core_tasks|tasks)\/\d+(?:[/?#]|$)/.test(href)) continue;
      const destination = localURL(href, url);
      if (!destination) continue;
      const location = route(destination);
      if (location.type === 'roster' && sourceURL(destination, url) &&
        (enrolled.test(txt(link)) || (route(url).type === 'roster' && link.rel === 'next'))) {
        sources.set(destination.pathname + destination.search, true);
      }
      if (location.classId && location.type !== 'task' && (!browsingCatalog || link.closest('nav,aside,[role="navigation"]'))) {
        const path = `/student/classes/${location.classId}/core_tasks`;
        if (location.type === 'tasks') {
          const requested = termFromURL(destination);
          if (requested && !isCurrentSelection(destination, requested.id)) sources.set(destination.pathname + '?' + new URLSearchParams([[requested.name, requested.id]]), true);
          sources.set(destination.pathname, true);
        }
        if (location.type !== 'tasks') sources.set(path, true);
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
    if (current.type === 'roster' && sourceURL(url, url)) sources.set(url.pathname + url.search, true);
    // Class pickers may expose enrolled destinations as native select values.
    const classChoices = browsingCatalog ? [] : doc.querySelectorAll('select option[value*="/student/classes/"]');
    for (const option of classChoices) {
      const target = localURL(option.getAttribute('value'), url);
      if (!target || route(target).type !== 'overview') continue;
      const classId = route(target).classId;
      classes[classId] ||= txt(option);
      sources.set(`/student/classes/${classId}/core_tasks`, true);
    }
    if (current.classId) {
      const path = `/student/classes/${current.classId}/core_tasks`;
      if (current.type !== 'tasks') sources.set(path, true);
      if (current.type === 'tasks') {
        const requested = termFromURL(url);
        if (requested) sources.set(url.pathname + '?' + new URLSearchParams([[requested.name, requested.id]]), true);
        sources.set(url.pathname, true);
        for (const select of doc.querySelectorAll('select')) {
          const form = select.closest('form');
          const name = select.getAttribute('name');
          const action = form && localURL(form.getAttribute('action') || url.href, url);
          const nativeTermForm = action && route(action).type === 'tasks' && route(action).classId === current.classId &&
            /^get$/i.test(form.getAttribute('method') || 'get') && isTermField(name);
          for (const option of select.querySelectorAll('option[value]')) {
            const value = option.getAttribute('value');
            if (!termLabel.test(txt(option))) continue;
            const target = localURL(value, url);
            const term = target && route(target).type === 'tasks' && route(target).classId === current.classId ? termFromURL(target) : null;
            if (term) {
              if (!isCurrentSelection(target, term.id)) sources.set(target.pathname + '?' + new URLSearchParams([[term.name, term.id]]), true);
            } else if (nativeTermForm && id(value) && !isCurrentSelection(action, value)) {
              sources.set(action.pathname + '?' + new URLSearchParams([[name, value]]), true);
            }
          }
        }
      }
    }
    return { sources: [...sources.keys()], classes };
  }

  function taskLink(node, url) {
    const preferred = node.querySelector('.h4.title a[href], .title a[href], .task-title a[href]');
    for (const link of [preferred, ...node.querySelectorAll('a[href]')]) {
      const destination = localURL(link?.getAttribute('href'), url);
      if (destination && route(destination).type === 'task') return { link, destination };
    }
    return {};
  }

  function taskNodes(doc, url) {
    const known = [...doc.querySelectorAll(selectors.tasks)].filter(exposed);
    const nodes = new Set(known.filter((node) => !node.matches('[data-task-id], [data-assignment-id], [data-assessment-id]') ||
      ['DIV', 'LI', 'ARTICLE', 'SECTION', 'TR'].includes(node.tagName)));
    for (const link of doc.querySelectorAll(assessmentLinks)) {
      if (link.closest(selectors.tasks) || !exposed(link)) continue;
      const destination = localURL(link.getAttribute('href'), url);
      if (!destination || route(destination).type !== 'task') continue;
      // An alternate task row needs its own stable task link and a local score container.
      for (let row = link.parentElement; row && !row.matches('main, body'); row = row.parentElement) {
        const links = [...row.querySelectorAll('a[href]')].filter((item) => {
          const target = localURL(item.getAttribute('href'), url);
          return target && route(target).type === 'task';
        });
        if (links.some((item) => localURL(item.getAttribute('href'), url).pathname !== destination.pathname)) break;
        if (row.matches('tr,[role="row"]') || row.querySelector([selectors.score, selectors.points, selectors.letter, selectors.rubric].join(','))) {
          nodes.add(row);
          break;
        }
      }
    }
    return [...nodes];
  }

  function taskDestination(task, base) {
    const url = localURL(task.taskUrl, base);
    const target = url && route(url);
    return target?.type === 'task' && target.classId === task.classId && target.taskId === task.id && !url.search && !url.hash ? url : null;
  }

  function readTask(node, url, context, term, classes, weights, detail = false) {
    const { link, destination } = detail ? { destination: url } : taskLink(node, url);
    const linked = destination && route(destination);
    const declared = [...new Set(['data-task-id', 'data-assignment-id', 'data-assessment-id']
      .map((name) => node.getAttribute(name)).filter(Boolean))];
    if (declared.length > 1 || (linked && declared.length && declared[0] !== linked.taskId)) return null;
    const taskId = linked?.taskId || (context.type === 'tasks' && stableOption(declared[0]));
    const classId = linked?.classId || context.classId;
    if (!taskId || !classId || (context.classId && classId !== context.classId) ||
      (node.hasAttribute('data-class-id') && node.getAttribute('data-class-id') !== classId)) return null;
    const termOwner = node.closest('[data-term-id],[data-academic-term-id],[data-semester-id]');
    const termId = id(termOwner?.getAttribute('data-term-id') || termOwner?.getAttribute('data-academic-term-id') ||
      termOwner?.getAttribute('data-semester-id')) || (context.type === 'tasks' || detail ? term.id : null);
    const labels = [...node.querySelectorAll('.labels-set .label')]
      .filter((label) => !label.closest(selectors.score)).map(txt).filter(Boolean);
    const assessmentType = clean(node.getAttribute('data-assessment-type')) ||
      labels.find((label) => /^(formative|summative)$/i.test(label)) || '';
    const subject = clean(node.getAttribute('data-subject')) ||
      firstText(node, '.class-name, .subject-name, [data-class-name] a, a[href$="/classes/' + classId + '"]') ||
      classes[classId] || '';
    const weightedNames = new Set(Object.keys(weights).map(app.key));
    const categories = [...new Set(labels.filter((label) => app.key(label) !== app.key(subject) &&
      (label !== assessmentType || weightedNames.has(app.key(label)))))];
    const recognized = categories.filter((label) => weightedNames.has(app.key(label)));
    const explicitCategory = clean(node.getAttribute('data-category')) || firstText(node, '.assessment-category, .task-category');
    const category = explicitCategory || (recognized.length === 1 ? recognized[0] : categories.length === 1 ? categories[0] : '');
    const outsideRubric = (element) => exposed(element) && !element.closest(selectors.rubric);
    const scores = [...node.querySelectorAll(selectors.score)].filter(outsideRubric);
    const score = node.matches(selectors.score) && outsideRubric(node) ? node : scores[0];
    const points = [...node.querySelectorAll(selectors.points)].filter((item) => outsideRubric(item) &&
      (!item.querySelector(selectors.rubric) || item.hasAttribute('data-earned-points')));
    if (node.matches(selectors.points) && outsideRubric(node)) points.push(node);
    const pointsText = /^(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)\s*(?:pts?\.?|points?|marks?)?$/i;
    const parse = (item) => item.hasAttribute('data-earned-points') || item.hasAttribute('data-max-points')
      ? [numeric(item.getAttribute('data-earned-points')), numeric(item.getAttribute('data-max-points'))]
      : txt(item).match(pointsText)?.slice(1).map(Number);
    const parsed = points.map(parse);
    if (!points.length) {
      for (const item of new Set([...(score ? [score] : []), ...scores])) {
        // Don't interpret a criterion's points as the assignment's total.
        if (item.querySelector(selectors.rubric)) continue;
        const match = parse(item);
        if (match) parsed.push(match);
      }
    }
    const first = parsed[0];
    const scoreMatch = first && parsed.every((match) => match?.[0] === first[0] && match?.[1] === first[1]) ? first : null;
    const letterNode = [...node.querySelectorAll(selectors.letter)].find(outsideRubric);
    const displayedLetter = clean(letterNode?.getAttribute('data-letter-grade')) || txt(letterNode);
    const rubric = [...node.querySelectorAll(selectors.rubric)].some(exposed);
    const resultsLink = Boolean(destination) && !detail && [...node.querySelectorAll('a[data-assessment-result-link],a[data-task-result-link],a[aria-label]')]
      .some((item) => (item.matches('[data-assessment-result-link],[data-task-result-link]') ||
        /^view (?:grade|result|assessment result)$/i.test(item.getAttribute('aria-label'))) &&
        localURL(item.getAttribute('href'), url)?.pathname === destination.pathname);
    const explicitlyUngraded = Boolean(score?.matches('[data-graded="false"]') || node.matches('[data-graded="false"]'));
    const excluded = node.matches('[data-grade-eligible="false"],[data-counts-toward-grade="false"]');
    const result = {
      id: taskId, classId, subject, termId, category, assessmentType,
      title: txt(link) || firstText(node, '.task-title,.title') || `Assessment ${taskId}`,
      earnedPoints: scoreMatch?.[0] ?? null,
      maxPoints: scoreMatch?.[1] ?? null,
      displayedLetter,
      status: firstText(node, '.submission-status, .task-status') ||
        (txt(score).match(/\b(not submitted|submitted|pending|ungraded)\b/i)?.[0] ?? ''),
      taskUrl: destination?.pathname ?? null,
      excluded, explicitlyUngraded, resultsLink, gradeKind: 'ungraded', issue: null
    };
    if (explicitlyUngraded) {
      result.earnedPoints = null;
      result.maxPoints = null;
    } else if (!app.validScore(result)) {
      const hasLetter = /^[A-Z]{1,2}[*+−-]?$/i.test(displayedLetter);
      result.gradeKind = points.length || parsed.length ? 'invalid' : rubric ? 'rubric' : hasLetter ? 'letter' : 'ungraded';
      if (result.gradeKind !== 'ungraded') result.issue = {
        invalid: 'Points unavailable or invalid',
        rubric: 'Rubric criteria without assignment points',
        letter: 'Letter grade without assignment points'
      }[result.gradeKind];
      result.earnedPoints = null;
      result.maxPoints = null;
    } else {
      result.gradeKind = 'points';
      if (!category) result.issue = 'Category unavailable or ambiguous';
    }
    return result;
  }

  function scanTaskDetail(doc, url, known) {
    const context = route(url);
    if (context.type !== 'task' || context.classId !== known.classId || context.taskId !== known.id || !known.termId) return null;
    // Only use a dedicated assignment result region. Other parts of a detail page can contain rubric or class scores.
    const results = [...doc.querySelectorAll('[data-assessment-result], .assessment-result')].filter(exposed);
    if (results.length !== 1) return null;
    const term = pageTerm(doc, url);
    if (term.id && term.id !== known.termId) return null;
    const score = readTask(results[0], url, context, { id: known.termId }, {}, {}, true);
    if (!score || score.termId !== known.termId || !app.validScore(score)) return null;
    return { context, term: { id: known.termId, label: null }, sources: [], classes: {}, weights: {},
      records: [{ ...known, earnedPoints: score.earnedPoints, maxPoints: score.maxPoints, gradeKind: 'points',
        issue: known.category ? null : 'Category unavailable or ambiguous' }], completeRecord: true, at: Date.now() };
  }

  function readScoreChanges(url, previous, rows) {
    if (!previous || previous.context.type !== 'tasks' || !previous.term.id || !rows?.size) return null;
    const existing = new Map(previous.records.map((task) => [task.id, task]));
    const updates = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row.isConnected || !exposed(row)) return null;
      const task = readTask(row, url, previous.context, previous.term, previous.classes, previous.weights);
      const old = existing.get(task?.id);
      if (!old || old.termId !== task.termId || old.issue === 'Conflicting assessment records' || seen.has(task.id)) return null;
      seen.add(task.id);
      if (JSON.stringify(old) === JSON.stringify(task)) continue;
      updates.push(task);
    }
    return updates;
  }

  function scan(doc, url) {
    const context = route(url);
    const surface = context.type === 'tasks' ? taskSurface(doc) : {};
    const term = pageTerm(doc, url, surface);
    const found = discover(doc, url, term.id);
    const weights = readWeights(doc);
    const scale = readScale(doc);
    const records = new Map();
    const scannable = ['tasks', 'workspace'].includes(context.type);
    const nodes = scannable ? taskNodes(doc, url) : [];
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
      [...url.searchParams.keys()].every(isTermField);

    const assessments = [...records.values()];
    const diagnostic = {
      page: context.type, term: Boolean(term.id), section: Boolean(surface.title), chart: Boolean(surface.chart),
      candidates: nodes.length, parsed: assessments.length,
      points: assessments.filter(app.validScore).length,
      scoreIssues: assessments.filter((task) => task.issue && !app.validScore(task)).length,
      unassigned: assessments.filter((task) => app.validScore(task) && !task.termId).length,
      weights: Object.keys(weights).length, complete,
      loading: Boolean(surface.section?.querySelector('[aria-busy="true"],[data-loading="true"]')) ||
        Boolean(term.id && [...(surface.section?.querySelectorAll('[data-task-list="all"][data-term-id]') ?? [])]
          .some((list) => exposed(list) && list.getAttribute('data-term-id') !== term.id))
    };
    return {
      ...found, context, term, weights, scale, records: assessments, complete, diagnostic,
      readable: Boolean(assessments.length || complete || Object.keys(weights).length || scale),
      at: Date.now()
    };
  }

  Object.assign(app, { selectors, clean, numeric, localURL, route, pageTerm, account, accountEvidence, accountLinks, selfProfile, profileEmail, scan, workspacePath, studentPath, heading, taskSurface, termFromURL, sourceURL, readScoreChanges, scanTaskDetail, discoveryLinks, taskDestination });
})();
