(() => {
  const app = globalThis.MBGC;
  const icons = {
    grades: 'M4 19h16M6 15v-4m6 4V6m6 9V9',
    estimator: 'M5 4v16m7-16v16m7-16v16M2 9h6m1 6h6m1-7h6',
    refresh: 'M20 7v5h-5M4 17v-5h5m11 0a8 8 0 0 0-14-5m-2 5a8 8 0 0 0 14 5',
    chevron: 'm6 9 6 6 6-6',
    arrow: 'M4 12h15m-6-6 6 6-6 6',
    close: 'm6 6 12 12M18 6 6 18',
    settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
    book: 'M5 4h13a1 1 0 0 1 1 1v15H6a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1Zm0 12h14M8 8h7',
    plus: 'M12 5v14M5 12h14',
    target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-5h.01',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3 2'
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', icons[name]);
    svg.append(path);
    return svg;
  }
  function h(tag, classes, ...children) {
    const node = document.createElement(tag);
    if (classes) node.className = classes;
    for (const child of children.flat()) {
      if (child !== null && child !== undefined && child !== false) node.append(child);
    }
    return node;
  }
  function button(text, action, glyph, className = '') {
    const node = h('button', 'mbgc-button ' + className, glyph ? icon(glyph) : null, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }
  const percentageFormat = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const percent = (value) => Number.isFinite(value)
    ? percentageFormat.format(value) + '%'
    : '—';
  const number = (value, digits = 2) => new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
  const time = (stamp) => stamp ? new Date(stamp).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }) : 'Never synced';
  const terms = (sync) => new Map(Object.values(sync.cache.classes).flatMap((subject) => Object.entries(subject.terms))
    .sort(([, a], [, b]) => (a.lastScan ?? 0) - (b.lastScan ?? 0) ||
      Number(a.label !== 'Selected academic term') - Number(b.label !== 'Selected academic term'))
    .map(([id, bucket]) => [id, bucket.label]));

  function termOptionsFor(sync, view) {
    const options = [[app.currentTerms, 'Current class terms'], ...terms(sync)];
    if (!options.some(([id]) => id === view.term)) view.term = app.currentTerms;
    return options;
  }

  function syncStatus(sync) {
    const scan = sync.diagnostics;
    if (sync.storageState === 'unavailable') return 'Grade cache unavailable. Grades found on this page are temporary. Reload the extension and this tab, then refresh.';
    if (!scan) return 'Checking the current page…';
    if (scan.failed) return 'Page extraction failed. Reload Class Tasks and use Refresh now.';
    if (scan.loading) return 'The selected term is still loading. Wait for the native task list or refresh it.';
    if (!['tasks', 'workspace'].includes(scan.page)) return sync.cache.lastSync ? '' :
      (sync.account ? 'Checking available class pages for grades.' : 'Student identity unavailable. Only this page’s grades can be used.');
    if (!scan.parsed) return scan.candidates
      ? 'Task elements were found, but their stable assessment links could not be read. Check Sync diagnostics.'
      : 'No assessment rows detected on this page. Load the native task list or open Tasks & Deadlines → Past.';
    if (scan.page === 'tasks' && !scan.term) return 'The selected class term has no recognized identifier. Switch terms in the native selector and check Sync diagnostics.';
    if (!scan.points) return scan.scoreIssues
      ? 'Grades are displayed, but no usable earned and maximum points were detected. Letter grades or rubric criteria alone cannot produce a percentage.'
      : 'Assessments were read. No graded points are available yet.';
    if (scan.unassigned) return 'Some scored tasks have no verified term and were excluded. Open the corresponding Class Tasks page.';
    if (scan.page === 'tasks' && !scan.weights) return 'Scored tasks were read. Open ManageBac’s category weights panel or enter verified weights in Overall Grades → Settings.';
    return '';
  }

  function syncDiagnostics(sync, view) {
    const report = sync.diagnostics;
    const details = h('details', 'mbgc-overrides mbgc-diagnostics');
    details.open = Boolean(view.diagnosticsOpen);
    details.addEventListener('toggle', () => { view.diagnosticsOpen = details.open; });
    details.append(h('summary', '', 'Sync diagnostics'));
    details.append(h('p', 'mbgc-muted', 'Extension version ' + chrome.runtime.getManifest().version));
    const storage = sync.storageState === 'session' ? 'Verified student grade cache' :
      sync.storageState === 'unavailable' ? 'Grade cache unavailable · current document only' :
        'Current document only · student identity could not be verified';
    details.append(h('p', 'mbgc-muted', storage));
    if (!sync.account && sync.identityStatus) {
      const reason = {
        conflicting: 'The page exposed conflicting account identifiers.',
        'profile-unverified': 'ManageBac’s self-profile page did not expose a verifiable account identifier.',
        'profile-without-id': 'The profile menu was found, but its link did not expose a recognized student ID.',
        missing: 'No account identifier or self-profile link was detected. Open the ManageBac avatar menu and check again.'
      }[sync.identityStatus];
      if (reason) details.append(h('p', 'mbgc-muted', reason));
    }
    if (report && !report.failed && ['tasks', 'workspace'].includes(report.page)) {
      details.append(h('p', 'mbgc-muted',
        `${report.parsed} assessments read of ${report.candidates} candidates · ${report.points} with usable points · ${report.scoreIssues} with missing or invalid points · ${report.weights} category weights`),
      h('p', 'mbgc-muted', report.term ? 'Selected term identifier recognized.' : 'Selected term identifier unavailable.',
        report.page === 'tasks' ? (report.chart ? ' Native chart recognized.' : ' Native chart anchor unavailable.') : '',
        report.complete ? ' Complete list verified.' : ' List completeness unverified.'));
    }
    if (!sync.account) details.append(h('p', 'mbgc-muted',
      'Open Overall Grades or Grade Estimator from the sidebar while still on the Class Tasks page to use the current document’s data.'));
    return details;
  }

  const calculated = new WeakMap();
  function gradeData(sync, classId, termKey) {
    const entry = sync.cache.classes[classId];
    const bucket = entry?.terms[termKey];
    const cached = bucket && calculated.get(bucket);
    const verified = Boolean(bucket?.termId);
    const weights = sync.overrides.weights[classId] ?? bucket?.weights ?? {};
    const error = bucket?.lastErrorAt ? bucket.lastError : entry?.lastError;
    const scale = sync.overrides.scale ?? bucket?.scale ?? app.defaultScale;
    const scaleLabel = sync.overrides.scale ? 'Custom letter scale' : bucket?.scale ? 'Displayed task letter scale' : 'Default task letter scale';
    const method = sync.settings.method;
    const compatible = cached?.weights === weights && cached.method === method && cached.revision === bucket?.dataRevision;
    const tasks = compatible ? cached.tasks : Object.values(bucket?.records ?? {}).sort((a, b) => a.title.localeCompare(b.title));
    const result = compatible ? cached.result : app.calculate(verified ? tasks : [], weights, method);
    if (bucket && !compatible) calculated.set(bucket, { tasks, result, weights, method, revision: bucket.dataRevision });
    const lastSource = { rendered: 'rendered student page', background: 'background HTML' }[bucket?.lastSource];
    const provenance = lastSource
      ? (error || (sync.openedAt && bucket.lastScan < sync.openedAt) ? 'Cache · last read from ' + lastSource : 'Source: ' + lastSource)
      : (bucket?.lastScan ? 'Source: cache' : 'Source unavailable');
    const staleAfter = Math.max(15, sync.settings.refreshMinutes * 2) * 60000;
    const stale = Boolean(bucket?.lastScan && Date.now() - bucket.lastScan > staleAfter);
    const provisional = !bucket?.complete || Boolean(error) || result.flagged > 0 || stale || Boolean(sync.overrides.weights[classId]);
    const missing = !verified ? 'Term unavailable. Confirm the academic term in Class Tasks.' :
      result.missing.length ? `Weights needed for ${result.missing.join(', ')}.` :
        !result.count ? (result.flagged ? 'Assessment points are missing or invalid.' :
          bucket?.complete ? 'No graded assessments in this term.' :
            'Could not verify graded assessments for this term.') :
          result.percentage === null ? 'No graded assessments have a positive category weight.' : '';
    return { classId, title: entry?.name || `Class ${classId}`, bucket, tasks, verified, weights, scale, scaleLabel,
      result, stale, provisional, error, missing, provenance, termKey, label: bucket?.label || 'Unidentified term' };
  }

  function score(value, scale, className = '') {
    const label = app.letter(value, scale);
    const available = Number.isFinite(value);
    return h('div', 'mbgc-score ' + className,
      h('span', available ? 'mbgc-numeral' : 'mbgc-numeral mbgc-unavailable',
        available ? percent(value) : 'No grade available'),
      label ? h('span', 'mbgc-letter', label) : null);
  }

  function track(value, label, className = '') {
    const node = h('div', 'mbgc-track ' + className, h('span', 'mbgc-track-fill'));
    node.setAttribute('role', 'meter');
    node.setAttribute('aria-label', label);
    node.setAttribute('aria-valuemin', '0');
    node.setAttribute('aria-valuemax', '100');
    updateTrack(node, value);
    return node;
  }
  function updateTrack(node, value) {
    node.hidden = !Number.isFinite(value);
    node.setAttribute('aria-valuenow', Number.isFinite(value) ? String(value) : '0');
    node.style.setProperty('--mbgc-progress', (value ?? 0) + '%');
  }

  function field(label, input) {
    input.setAttribute('aria-label', label);
    return h('label', 'mbgc-field', h('span', 'mbgc-field-label', label), input);
  }
  function select(options, value, action) {
    const node = h('select', 'mbgc-input');
    for (const [id, text] of options) {
      const option = h('option', '', text);
      option.value = id;
      node.append(option);
    }
    if (options.some(([id]) => id === value)) node.value = value;
    if (action) node.addEventListener('change', () => action(node.value));
    return node;
  }
  function numericInput(value, min, max, step = 'any') {
    const node = h('input', 'mbgc-input');
    Object.assign(node, { type: 'number', value: Number.isFinite(value) ? value : '', min, max, step, inputMode: 'decimal' });
    return node;
  }

  function categoryDetails(result, tasks) {
    const list = h('div', 'mbgc-categories');
    for (const category of result.breakdown) {
      const row = h('section', 'mbgc-category',
        h('div', 'mbgc-category-heading',
          h('div', '', h('h4', '', category.name),
            h('p', 'mbgc-muted', Number.isFinite(category.weight) ? `${category.weight}% weight` : 'Weight unavailable',
              ' · ', `${category.gradedCount} graded`, category.simulated ? ' · Hypothetical' : '')),
          h('strong', 'mbgc-category-value', percent(category.average))),
        track(category.average, category.name + ' average'));
      for (const task of category.tasks) {
        const title = task.taskUrl ? h('a', 'mbgc-assessment-link', task.title) : h('span', '', task.title);
        if (task.taskUrl) title.href = task.taskUrl;
        row.append(h('div', 'mbgc-assessment',
          h('div', '', title, h('small', 'mbgc-muted', [task.assessmentType, task.scenario ? 'Hypothetical' : '', task.issue || task.status].filter(Boolean).join(' · '))),
          h('span', 'mbgc-assessment-score', app.validScore(task) ? `${task.earnedPoints} / ${task.maxPoints}` :
            task.gradeKind === 'rubric' ? 'Rubric only' :
              task.gradeKind === 'letter' ? task.displayedLetter + ' (letter only)' :
                task.issue ? 'Points unavailable' : 'Ungraded')));
      }
      list.append(row);
    }
    if (!result.breakdown.length && tasks.length) {
      list.append(h('p', 'mbgc-muted', `${tasks.length} assessment records await a verified term.`));
      for (const task of tasks) list.append(h('p', 'mbgc-muted', task.title));
    }
    return list;
  }

  function labelStatus(data) {
    return data.error ? "Couldn’t refresh" : data.stale ? 'Last sync out of date' : data.provisional ? 'Some grades unavailable' : data.result.count ? 'Up to date' : 'No graded assessments';
  }

  function compact(sync, data, type, changed) {
    const name = type === 'tasks' ? 'Overall Grade' : 'Current Calculated Grade';
    const item = h('section', 'mbgc-compact',
      h('div', 'mbgc-compact-main', h('span', 'mbgc-mark', icon('grades')),
        h('div', '', h('h2', '', name),
          h('p', 'mbgc-muted', app.methods[sync.settings.method].label, ' · ', data.label))),
      h('div', 'mbgc-compact-result', score(data.result.percentage, data.scale),
        h('span', 'mbgc-chip', labelStatus(data))),
      h('p', 'mbgc-compact-note mbgc-muted',
        changed ? 'Grade updated · ' : '',
        data.verified ? `${data.result.count} graded assessment${data.result.count === 1 ? '' : 's'}. ` : '',
        data.missing ? data.missing + ' ' : '',
        data.bucket?.lastScan ? `Synced ${time(data.bucket.lastScan)}. ` : '',
        data.error ? data.error + ' ' : '',
        (type === 'tasks' || sync.storageState === 'unavailable') && syncStatus(sync)
          ? ' ' + syncStatus(sync) : ''));
    item.setAttribute('aria-label', name);
    return item;
  }

  function subjectRow(sync, data, view) {
    const details = h('details', 'mbgc-subject');
    details.dataset.classId = data.classId;
    details.gradeEntry = sync.cache.classes[data.classId];
    details.gradeKey = JSON.stringify([data.termKey, data.bucket?.dataRevision, sync.settings.method, data.weights, data.scaleLabel,
      data.stale, data.error, view.changed.has(data.classId + ':' + data.termKey)]);
    details.open = view.expanded.has(data.classId);
    let breakdown;
    function openBreakdown() {
      if (!breakdown) breakdown = categoryDetails(data.result, data.tasks);
      const content = details.querySelector('.mbgc-subject-detail');
      if (content && breakdown.parentNode !== content) content.append(breakdown);
    }
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open) {
        view.expanded.add(data.classId);
        openBreakdown();
      } else view.expanded.delete(data.classId);
    });
    const uri = '/student/classes/' + data.classId + '/core_tasks';
    const open = h('a', 'mbgc-text-link', 'Open class Tasks', icon('arrow'));
    open.href = uri;
    details.append(
      h('summary', 'mbgc-subject-summary',
        h('div', 'mbgc-subject-name', h('span', 'mbgc-mark', icon('book')),
          h('div', '', h('h3', '', data.title), h('p', 'mbgc-muted',
            data.verified ? `${data.result.count} graded assessment${data.result.count === 1 ? '' : 's'} · ${data.label}` : 'Term unavailable',
            view.changed.has(data.classId + ':' + data.termKey) ? h('span', 'mbgc-updated', ' · Grade updated') : ''))),
        h('div', 'mbgc-subject-status', h('span', 'mbgc-chip', labelStatus(data))),
        h('div', 'mbgc-subject-grade', score(data.result.percentage, data.scale),
          track(data.result.percentage, data.title + ' calculated grade')),
        h('span', 'mbgc-chevron', icon('chevron'))),
      h('div', 'mbgc-subject-detail',
        data.missing ? h('p', 'mbgc-notice', data.missing) : null,
        data.error ? h('p', 'mbgc-notice', data.error) :
          data.bucket?.lastScan && !data.bucket.complete ? h('p', 'mbgc-muted',
            'The full task list could not be verified. Open Class Tasks if ManageBac loads additional assessments after rendering.') : null,
        h('div', 'mbgc-detail-meta',
          h('p', 'mbgc-muted', app.methods[sync.settings.method].explanation, ' ',
            data.scaleLabel, '. ', data.provenance, '. ',
            data.bucket?.lastScan ? `Last successful sync ${time(data.bucket.lastScan)}.` : 'No successful sync for this term.',
            data.result.ungraded ? ` ${data.result.ungraded} without usable scores.` : '',
            data.result.flagged ? ` ${data.result.flagged} flagged for review.` : '',
            data.result.excluded ? ` ${data.result.excluded} excluded by grading rules.` : ''),
          open)));
    if (details.open) openBreakdown();
    return details;
  }

  function empty(title, message, glyph = 'book') {
    return h('div', 'mbgc-empty', h('span', 'mbgc-mark', icon(glyph)), h('h3', '', title), h('p', 'mbgc-muted', message));
  }
  function parseLines(text, type) {
    const data = [];
    const keys = new Set();
    for (const line of text.split('\n').map((value) => value.trim()).filter(Boolean)) {
      const match = line.match(/^(.+?)\s*=\s*(\d+(?:\.\d+)?)$/);
      if (!match || !app.validWeight(Number(match[2]))) return null;
      const name = match[1].trim();
      if (!name || keys.has(app.key(name))) return null;
      keys.add(app.key(name));
      data.push(type === 'scale' ? [Number(match[2]), name] : [name, Number(match[2])]);
    }
    return data;
  }

  function settings(sync, subjects, view) {
    const content = h('details', 'mbgc-settings');
    content.open = view.settings;
    content.addEventListener('toggle', () => { view.settings = content.open; });
    const text = h('p', 'mbgc-muted', 'Refresh checks student-visible pages while ManageBac is active. Enter 0 to turn off periodic checks.');
    const minutes = numericInput(sync.settings.refreshMinutes, 0, 120, '1');
    minutes.addEventListener('change', () => {
      if (minutes.checkValidity() && minutes.value !== '') sync.setSettings({ refreshMinutes: minutes.valueAsNumber });
    });
    const classChoice = select(subjects, view.settingsClass);
    const weights = h('textarea', 'mbgc-input');
    const scale = h('textarea', 'mbgc-input');
    const feedback = h('p', 'mbgc-feedback');
    feedback.setAttribute('role', 'status');
    for (const input of [weights, scale]) input.rows = 4;
    const showWeights = () => {
      view.settingsClass = classChoice.value;
      weights.value = Object.entries(sync.overrides.weights[classChoice.value] ?? {}).map(([name, value]) => `${name} = ${value}`).join('\n');
    };
    classChoice.addEventListener('change', showWeights);
    showWeights();
    weights.placeholder = 'Coursework = 30';
    scale.placeholder = 'A* = 90\nA = 80\nU = 0';
    scale.value = (sync.overrides.scale ?? []).map(([min, label]) => `${label} = ${min}`).join('\n');
    const save = button('Save overrides', async () => {
      const weightsData = parseLines(weights.value, 'weights');
      const scaleData = parseLines(scale.value, 'scale');
      const normalized = scaleData?.length ? app.normalizeScale(scaleData) : null;
      if (!weightsData || !scaleData || (scaleData.length && !normalized)) {
        feedback.textContent = 'Enter one name = number per line. Use unique labels and percentages from 0 to 100. A letter scale also needs a 0% boundary.';
        return;
      }
      const next = { ...sync.overrides.weights };
      if (classChoice.value) {
        if (weightsData.length) next[classChoice.value] = Object.fromEntries(weightsData);
        else delete next[classChoice.value];
      }
      await sync.setOverrides({ weights: next, scale: normalized });
    }, null, 'mbgc-primary');
    const clear = button('Clear cached grades', () => {
      if (clear.dataset.confirm !== 'true') {
        clear.dataset.confirm = 'true';
        clear.textContent = 'Confirm clear';
        feedback.textContent = 'Clearing also removes manual overrides for this student.';
        return;
      }
      sync.clear();
    });
    content.append(h('summary', '', icon('settings'), 'Settings', icon('chevron')),
      h('div', 'mbgc-settings-body',
        h('div', 'mbgc-settings-grid',
          h('div', '', field('Refresh interval (minutes)', minutes), text),
          h('div', '', field('Class for manual weights', classChoice), field('Category weights', weights)),
          h('div', '', field('Letter boundaries', scale), h('p', 'mbgc-muted', 'Leave overrides blank to use detected values or the default task scale.'))),
        h('div', 'mbgc-actions', save, clear), feedback));
    if (!subjects.length) {
      classChoice.disabled = true;
      weights.disabled = true;
    }
    return content;
  }

  function header(sync, kind, view, handlers, termOptions) {
    const isEstimator = kind === 'estimator';
    const termChoice = select(termOptions, view.term, (id) => {
      view.term = id;
      view.scenario = null;
      handlers.render();
    });
    termChoice.disabled = !termOptions.length;
    const method = select(Object.entries(app.methods).map(([id, item]) => [id, item.label]), sync.settings.method,
      (id) => sync.setSettings({ method: id }));
    const refresh = button(sync.refreshing ? 'Refreshing…' : 'Refresh now', () => sync.refresh(true), 'refresh');
    refresh.disabled = sync.refreshing;
    const syncText = h('div', 'mbgc-sync-text', icon('clock'), sync.cache.lastSync ? `Last read ${time(sync.cache.lastSync)}` :
      sync.refreshing ? 'Checking pages' : 'No assessment data synced');
    const state = h('p', 'mbgc-feedback', [sync.message, syncStatus(sync)].filter(Boolean).join(' '));
    state.setAttribute('role', 'status');
    return h('header', 'mbgc-header',
      h('div', 'mbgc-header-line',
        h('div', 'mbgc-header-title', h('span', 'mbgc-mark mbgc-header-mark', icon(isEstimator ? 'estimator' : 'grades')),
          h('div', '', h('h1', '', isEstimator ? 'Grade Estimator' : 'Overall Grades'),
            h('p', 'mbgc-muted', isEstimator ? 'Explore future scores and see what it takes to reach your target.' :
              'Calculated estimates from your ManageBac assessments.'))),
        h('div', 'mbgc-header-actions', refresh, button('Back to ManageBac', handlers.close, 'close', 'mbgc-close'))),
      h('div', 'mbgc-toolbar',
        field('Academic term', termChoice),
        field('Calculation method', method),
        syncText), state, syncDiagnostics(sync, view));
  }

  function dashboard(sync, view, handlers) {
    const termOptions = termOptionsFor(sync, view);
    const classes = Object.entries(sync.cache.classes).sort(([, a], [, b]) => (a.name || '').localeCompare(b.name || ''));
    const subjects = classes.filter(([, entry]) => view.term === app.currentTerms || entry.terms[view.term] ||
      (view.term !== 'unknown' && !Object.keys(entry.terms).some((id) => id !== 'unknown')));
    const content = h('div', 'mbgc-page', header(sync, 'grades', view, handlers, termOptions),
      h('div', 'mbgc-section-heading', h('h2', '', 'Subjects'),
        h('span', 'mbgc-muted', `${subjects.length} ${subjects.length === 1 ? 'subject' : 'subjects'}`)));
    if (!subjects.length) {
      content.append(sync.refreshing && !sync.cache.lastSync
        ? h('div', 'mbgc-skeleton', h('span'), h('span'), h('span'))
        : empty('No grades for this term yet', 'Open Class Tasks or Tasks & Deadlines → Past, then load any additional tasks and refresh.'));
    } else {
      content.append(h('div', 'mbgc-subjects', subjects.map(([id, item]) => subjectRow(sync, gradeData(sync, id,
        view.term === app.currentTerms ? app.classTermKey(item) : view.term), view))));
    }
    content.append(h('p', 'mbgc-footnote', 'The school’s term calculation method and letter scale are unverified. Partial scans can miss assessments.'),
      settings(sync, classes.map(([id, item]) => [id, item.name || 'Class ' + id]), view));
    return content;
  }

  function patchDashboard(current, next) {
    const liveList = current?.querySelector('.mbgc-subjects');
    const nextList = next.querySelector('.mbgc-subjects');
    if (!liveList || !nextList) return false;
    const previous = new Map([...liveList.children].map((row) => [row.dataset.classId, row]));
    let position = liveList.firstElementChild;
    for (const row of [...nextList.children]) {
      const id = row.dataset.classId;
      const prior = previous.get(id);
      const chosen = prior?.gradeEntry === row.gradeEntry && prior.gradeKey === row.gradeKey ? prior : row;
      if (prior && chosen === row) chosen.open = prior.open;
      if (chosen !== position) liveList.insertBefore(chosen, position);
      position = chosen.nextElementSibling;
      if (prior && prior !== chosen) {
        if (position === prior) position = prior.nextElementSibling;
        prior.remove();
      }
      previous.delete(id);
    }
    for (const row of previous.values()) row.remove();
    const oldSections = [...current.children];
    [...next.children].forEach((section, index) => {
      if (section === nextList) return;
      const old = oldSections[index];
      const inputs = (node) => [...node.querySelectorAll('select, input, textarea')].map((input) => input.value).join('\u0000');
      if (old && (!old.isEqualNode(section) || inputs(old) !== inputs(section))) old.replaceWith(section);
    });
    current.className = next.className;
    return true;
  }

  function estimator(sync, view, handlers) {
    const termOptions = termOptionsFor(sync, view);
    const subjects = Object.entries(sync.cache.classes).filter(([, item]) =>
      view.term === app.currentTerms ? item.terms[app.classTermKey(item)] : item.terms[view.term])
      .map(([id, item]) => [id, item.name || 'Class ' + id]).sort(([, a], [, b]) => a.localeCompare(b));
    const page = h('div', 'mbgc-page', header(sync, 'estimator', view, handlers, termOptions));
    if (!subjects.some(([id]) => id === view.classId)) {
      view.classId = subjects[0]?.[0];
      view.scenario = null;
    }
    if (!view.classId) {
      page.append(empty('No subjects ready to model', 'Sync graded assessments and category weights in Class Tasks, then choose a confirmed term.', 'estimator'));
      return page;
    }
    const choice = select(subjects, view.classId, (id) => {
      view.classId = id;
      view.scenario = null;
      handlers.render();
    });
    page.append(h('div', 'mbgc-estimator-subject', field('Subject', choice)));
    const selectedKey = view.term === app.currentTerms ? app.classTermKey(sync.cache.classes[view.classId]) : view.term;
    if (view.scenarioTerm !== selectedKey) {
      view.scenarioTerm = selectedKey;
      view.scenario = null;
    }
    const data = gradeData(sync, view.classId, selectedKey);
    const categories = Object.keys(data.weights).filter((category) => data.weights[category] > 0);
    if (!data.verified || !categories.length) {
      page.append(empty(data.result.percentage === null ? 'No grade available' : 'This subject needs more information',
        data.verified ? 'Sync category weights in Class Tasks or add them under Overall Grades → Settings.' :
          'Identify the academic term in Class Tasks before modeling this subject.', 'estimator'));
      return page;
    }
    const firstCategory = categories[0];
    function defaults() {
      return { entries: [], overrides: {}, pick: firstCategory, points: 80, max: 100, replaces: '',
        target: 80, targetMode: 'percentage', targetLetter: data.scale.find(([min]) => min <= 80)?.[1] ?? data.scale[0][1] };
    }
    const model = view.scenario ??= defaults();
    if (!categories.includes(model.pick)) model.pick = firstCategory;
    const taskOptions = () => [['', 'Add a new assessment'],
      ...data.tasks.filter((task) => app.validScore(task) && app.key(task.category) === app.key(model.pick) &&
        !model.entries.some((entry) => entry.id !== model.editing && entry.replaces === task.id))
        .map((task) => [task.id, 'Replace ' + task.title])];
    if (!taskOptions().some(([id]) => id === model.replaces)) model.replaces = '';
    if (!data.scale.some(([, label]) => label === model.targetLetter)) model.targetLetter = defaults().targetLetter;

    const category = select(categories.map((name) => [name, name]), model.pick, (name) => {
      model.pick = name;
      model.replaces = '';
      handlers.render();
    });
    const replacing = select(taskOptions(), model.replaces, (id) => {
      model.replaces = id;
      const task = data.tasks.find((item) => item.id === id);
      if (task) {
        model.max = task.maxPoints;
        model.points = task.earnedPoints;
      }
      handlers.render();
    });
    const points = numericInput(model.points, 0, model.max);
    const max = numericInput(model.max, 0.01, 1000000);
    const slider = h('input', 'mbgc-slider');
    Object.assign(slider, { type: 'range', min: 0, max: 100, step: 0.1, value: 100 * model.points / model.max });
    slider.setAttribute('aria-label', 'Hypothetical score as a percentage');
    const sliderValue = h('output', 'mbgc-slider-value');
    const prediction = h('div', 'mbgc-prediction');
    const predictedScore = h('div', 'mbgc-predicted-score');
    predictedScore.setAttribute('aria-live', 'polite');
    const predictedTrack = track(null, 'Predicted grade', 'mbgc-track-large');
    const detailsContent = h('div', 'mbgc-estimator-breakdown');
    const targetResult = h('div', 'mbgc-target-result');
    targetResult.setAttribute('aria-live', 'polite');
    const warning = h('p', 'mbgc-feedback');

    const targetFormat = select([['percentage', 'Percentage'], ['letter', 'Letter grade']], model.targetMode, (value) => {
      model.targetMode = value;
      handlers.render();
    });
    const targetNumber = numericInput(model.target, 0, 100);
    targetNumber.addEventListener('input', () => {
      model.target = targetNumber.checkValidity() && targetNumber.value !== '' ? targetNumber.valueAsNumber : null;
      update();
    });
    const targetLetter = select(data.scale.map(([min, label]) => [label, `${label} · ${min}% minimum`]), model.targetLetter, (label) => {
      model.targetLetter = label;
      update();
    });

    function draft(earned = model.points) {
      return { id: model.editing ?? 'scenario:' + (view.nextId + 1), replaces: model.replaces,
        title: data.tasks.find((task) => task.id === model.replaces)?.title || 'Future ' + model.pick,
        category: model.pick, earnedPoints: earned, maxPoints: model.max, scenario: true };
    }
    function update() {
      const usable = app.validScore({ earnedPoints: model.points, maxPoints: model.max }) && model.max >= .01 && model.max <= 1000000;
      const input = draft();
      const entries = model.entries.filter((entry) => entry.id !== model.editing);
      const base = app.withHypotheticals(data.tasks, entries);
      const simulated = app.withHypotheticals(base, usable ? [input] : []);
      const result = app.calculate(simulated, data.weights, sync.settings.method, model.overrides);
      const target = model.targetMode === 'letter' ? data.scale.find(([, label]) => label === model.targetLetter)?.[0] : model.target;
      const required = app.targetScore({ tasks: base, weights: data.weights, method: sync.settings.method,
        overrides: model.overrides, future: input, target });
      const governedByOverride = Object.hasOwn(model.overrides, app.key(model.pick));
      sliderValue.textContent = usable ? percent(100 * model.points / model.max) : '—';
      slider.style.setProperty('--mbgc-progress', usable ? (100 * model.points / model.max) + '%' : '0%');
      warning.textContent = !usable ? 'Enter a score from zero to the maximum points.' :
        governedByOverride ? 'Remove the category override to model an individual score in this category.' : '';
      predictedScore.replaceChildren(score(usable ? result.percentage : null, data.scale));
      updateTrack(predictedTrack, usable ? result.percentage : null);
      add.disabled = !usable;
      detailsContent.replaceChildren(usable ? categoryDetails(result, simulated) : h('p', 'mbgc-muted', 'Enter valid points to preview the breakdown.'));
      const inactive = result.breakdown.filter((item) => item.weight > 0 && !item.taskCount).map((item) => item.name);
      const label = Number.isFinite(target) ? `Target ${model.targetMode === 'letter' ? model.targetLetter + ' · ' : ''}${percent(target)}` : 'Enter a target';
      targetResult.dataset.state = required.state;
      let title;
      let explanation;
      if (required.state === 'unavailable' || !usable) {
        title = 'Required score unavailable';
        explanation = 'Check the target, points, and category weights. A category override makes its individual task score unavailable.';
      } else if (required.state === 'impossible') {
        title = 'Target out of reach';
        explanation = `Full marks on this assessment would predict ${percent(required.predicted)} overall.`;
      } else {
        const minimum = Math.min(model.max, Math.ceil(required.required * 100) / 100);
        title = required.state === 'achieved' ? 'Already within reach at 0 points' : `${number(minimum, 6)} / ${number(model.max, 6)} points`;
        explanation = `${percent(100 * minimum / model.max)} on this assessment · ${percent(required.predicted)} predicted overall at the threshold.`;
      }
      targetResult.replaceChildren(h('span', 'mbgc-field-label', label), h('strong', '', title),
        h('p', '', explanation),
        h('p', 'mbgc-muted', inactive.length ? `Conditional on modeled scores. Still ungraded in this scenario: ${inactive.join(', ')}.` :
          'Conditional on the modeled assessments and current data.'));
    }

    points.addEventListener('input', () => {
      model.points = points.value === '' ? NaN : points.valueAsNumber;
      if (Number.isFinite(model.points)) slider.value = 100 * model.points / model.max;
      update();
    });
    max.addEventListener('input', () => {
      model.max = max.value === '' ? NaN : max.valueAsNumber;
      points.max = Number.isFinite(model.max) ? model.max : '';
      if (Number.isFinite(model.max) && model.max > 0) slider.value = 100 * model.points / model.max;
      update();
    });
    slider.addEventListener('input', () => {
      if (!Number.isFinite(model.max) || model.max < .01 || model.max > 1000000) return;
      model.points = Number((slider.valueAsNumber * model.max / 100).toPrecision(12));
      points.value = model.points;
      update();
    });
    const add = button(model.editing ? 'Save hypothetical' : 'Add hypothetical', () => {
      if (!app.validScore(draft()) || !max.checkValidity()) return;
      const task = draft();
      if (!model.editing) view.nextId++;
      model.entries = [...model.entries.filter((entry) => entry.id !== model.editing), task];
      delete model.editing;
      model.replaces = '';
      handlers.render();
    }, 'plus', 'mbgc-primary');
    // A saved draft stays in the prediction without also adding an unsaved duplicate.
    const saveDraft = add.onclick;
    add.addEventListener('click', () => {
      if (app.validScore(draft()) && max.checkValidity()) {
        model.previewPaused = true;
        handlers.render();
      }
    });
    for (const input of [points, max, slider]) input.addEventListener('input', () => {
      if (model.previewPaused) {
        model.previewPaused = false;
        update();
      }
    });
    const scenarios = h('div', 'mbgc-scenarios',
      model.entries.map((task) => h('div', 'mbgc-scenario',
        h('div', '', h('strong', '', task.title), h('small', 'mbgc-muted', `${task.earnedPoints} / ${task.maxPoints}`)),
        button('Edit', () => {
          Object.assign(model, { editing: task.id, pick: task.category, points: task.earnedPoints, max: task.maxPoints,
            replaces: task.replaces, previewPaused: false });
          handlers.render();
        }),
        button('Remove', () => {
          model.entries = model.entries.filter((entry) => entry.id !== task.id);
          if (model.editing === task.id) { delete model.editing; model.replaces = ''; }
          handlers.render();
        }))));
    const overrideDetails = h('details', 'mbgc-overrides');
    overrideDetails.append(h('summary', '', 'Category percentage overrides'),
      h('p', 'mbgc-muted', 'Enter a category average if individual scores are unavailable. Absolute Weights uses the existing graded task count, or one modeled task for an empty category.'));
    for (const name of categories) {
      const id = app.key(name);
      const control = numericInput(model.overrides[id] ?? '', 0, 100);
      control.placeholder = 'Use task scores';
      control.addEventListener('input', () => {
        if (control.value === '') delete model.overrides[id];
        else if (control.checkValidity()) model.overrides[id] = control.valueAsNumber;
        update();
      });
      overrideDetails.append(field(name + ' (%)', control));
    }
    const restore = () => {
      view.scenario = { ...defaults(), previewPaused: true };
      handlers.render();
    };
    prediction.append(h('div', 'mbgc-prediction-top', icon('estimator'), h('span', '', 'What-if prediction')),
      predictedScore, predictedTrack,
      h('div', 'mbgc-actual', h('span', '', 'Current calculated grade'), score(data.result.percentage, data.scale)),
      h('p', 'mbgc-muted', data.missing || labelStatus(data) + ' · ' + data.scaleLabel));
    const breakdown = h('details', 'mbgc-overrides');
    breakdown.open = view.breakdownOpen;
    breakdown.addEventListener('toggle', () => { view.breakdownOpen = breakdown.open; });
    breakdown.append(h('summary', '', 'Category breakdown'), detailsContent);
    page.append(
      h('div', 'mbgc-estimator-grid',
        h('section', 'mbgc-panel mbgc-model',
          h('div', 'mbgc-panel-heading', h('span', 'mbgc-mark', icon('estimator')), h('div', '', h('h2', '', 'Model an assessment'),
            h('p', 'mbgc-muted', 'The score previews immediately. Add it to keep it in your scenario.'))),
          h('div', 'mbgc-form-grid', field('Category', category), field('Assessment action', replacing)),
          h('div', 'mbgc-form-grid', field('Earned points', points), field('Maximum points', max)),
          h('div', 'mbgc-slider-row', slider, sliderValue), warning,
          h('div', 'mbgc-actions', add, button('Reset', () => { view.scenario = defaults(); handlers.render(); }),
            button('Restore actual grades', restore)),
          scenarios, overrideDetails),
        h('div', 'mbgc-estimator-results', prediction,
          h('section', 'mbgc-panel mbgc-target',
            h('div', 'mbgc-panel-heading', h('span', 'mbgc-mark', icon('target')),
              h('div', '', h('h2', '', 'Target grade'), h('p', 'mbgc-muted', 'Minimum score for the assessment modeled here.'))),
            h('div', 'mbgc-form-grid', field('Target type', targetFormat),
              model.targetMode === 'letter' ? field('Letter grade', targetLetter) : field('Target (%)', targetNumber)),
            targetResult))),
      breakdown);
    update();
    return page;
  }
  Object.assign(app, { h, icon, button, gradeData, compact, dashboard, patchDashboard, estimator });
})();
