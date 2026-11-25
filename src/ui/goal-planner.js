(() => {
  const app = globalThis.MBGC;
  const { h, button, field, select, numericInput, percent, number, time } = app;
  const tabs = [['try', 'Try a Grade'], ['goal', 'Goal Planner'], ['saved', 'Saved Plans']];
  const note = (text) => h('p', 'mbgc-muted', text);
  const readNumber = (input) => input.value && input.checkValidity() ? input.valueAsNumber : null;

  function estimatorTabs(view, handlers) {
    const current = view.estimatorTab ?? 'try';
    const group = h('div', 'mbgc-mode mbgc-estimator-tabs');
    group.setAttribute('role', 'tablist');
    group.setAttribute('aria-label', 'Grade Estimator tools');
    function choose(id) {
      view.estimatorTab = id;
      if (id === 'saved' && view.goalLibrary) {
        view.goalLibrary.loaded = false;
        view.goalLibrary.error = '';
      }
      handlers.render();
    }
    tabs.forEach(([id, label], index) => {
      const tab = button(label, () => choose(id));
      tab.id = 'mbgc-estimator-tab-' + id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-label', label);
      tab.setAttribute('aria-controls', 'mbgc-estimator-panel');
      tab.setAttribute('aria-selected', String(current === id));
      tab.tabIndex = current === id ? 0 : -1;
      tab.addEventListener('keydown', (event) => {
        const next = { ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length,
          Home: 0, End: tabs.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        const tree = tab.getRootNode();
        choose(tabs[next][0]);
        tree.getElementById('mbgc-estimator-tab-' + tabs[next][0])?.focus();
      });
      group.append(tab);
    });
    return group;
  }

  const scopeOf = (data) => JSON.stringify([data.classId, data.bucket?.termId]);
  const draftOf = () => ({ id: crypto.randomUUID(), name: '', targetType: 'percentage', percentage: 80, letter: '', tasks: [] });

  function goalPlanner(sync, view, handlers, data) {
    const savedTab = view.estimatorTab === 'saved';
    const title = h('h2', '', savedTab ? 'Saved Grade Plans' : 'Grade Goal Planner');
    const panel = h('section', 'mbgc-goal-card', title);
    if (!data.verified) {
      panel.append(note('Choose a confirmed academic term to plan grades or access its saved plans.'));
      return panel;
    }
    const scope = scopeOf(data);
    const drafts = view.goalDrafts ??= new Map();
    if (!drafts.has(scope)) drafts.set(scope, draftOf());
    const draft = drafts.get(scope);
    const library = view.goalLibrary ??= { saved: [], loaded: false, busy: false, error: '' };
    const source = app.goalDataVersion(data);
    const categories = Object.entries(data.weights).filter(([, weight]) => app.validWeight(weight));
    const heading = note(`${data.label} · ${app.methods[data.method].label}`);
    panel.append(heading);

    async function persist(operation, plan) {
      if (library.busy) return;
      library.busy = true;
      library.error = '';
      handlers.render();
      try {
        const response = await sync.goalPlans(operation, plan);
        library.saved = response.saved;
        library.loaded = true;
        if (response.entry) {
          Object.assign(draft, { source: response.entry.source, revision: response.entry.revision, name: response.entry.name, message: 'Plan saved.' });
        }
        if (operation === 'delete' && draft.id === plan.id) drafts.delete(scope);
      } catch (error) {
        library.error = error.message;
      } finally {
        library.busy = false;
        handlers.render();
      }
    }

    if (savedTab) {
      if (!sync.account) {
        panel.append(note('Verify your student account in ManageBac to access saved plans.'));
        return panel;
      }
      if (!library.loaded && !library.busy && !library.reading) {
        library.reading = true;
        sync.goalPlans('list').then((saved) => { library.saved = saved; }).catch((error) => {
          library.error = error.message;
        }).finally(() => {
          library.loaded = true;
          library.reading = false;
          handlers.render();
        });
      }
      if (library.reading) {
        panel.append(note('Loading saved plans for this subject and term…'));
        return panel;
      }
      const list = library.saved.filter((plan) => plan.classId === data.classId && plan.termId === data.bucket.termId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      function openPlan(plan) {
        drafts.set(scope, {
          ...draftOf(), id: plan.id, revision: plan.revision, source: plan.source, name: plan.name,
          targetType: plan.targetType, [plan.targetType]: plan.target, tasks: plan.tasks.map((row) => ({ ...row }))
        });
        view.estimatorTab = 'goal';
        handlers.render();
      }
      if (library.error) panel.append(h('p', 'mbgc-feedback', library.error));
      if (!list.length) panel.append(note('No plans saved for this subject and term yet.'));
      for (const plan of list) {
        const open = button('Open plan', () => openPlan(plan));
        const remove = button('Delete plan', () => {
          if (library.confirm === plan.id) {
            library.confirm = null;
            void persist('delete', plan);
          } else {
            library.confirm = plan.id;
            handlers.render();
          }
        });
        open.setAttribute('aria-label', 'Open plan ' + plan.name);
        remove.setAttribute('aria-label', (library.confirm === plan.id ? 'Confirm deletion of ' : 'Delete plan ') + plan.name);
        if (library.confirm === plan.id) remove.textContent = 'Confirm delete';
        remove.disabled = library.busy;
        panel.append(h('article', 'mbgc-goal-saved-row', h('div', '', h('h3', '', plan.name),
          note(`${plan.targetType === 'percentage' ? percent(plan.target) : plan.target} · ${plan.tasks.length} planned · Saved ${time(plan.updatedAt)}`),
          plan.source !== source ? note('Grade data or calculation settings changed since this plan was saved.') : null),
        h('div', 'mbgc-actions', open, remove)));
      }
      return panel;
    }

    panel.append(note('Choose a target and add future assessments. Enter a fixed mark only when you want the plan to assume that score.'));
    if (draft.source && draft.source !== source) panel.append(note('Grade data or calculation settings changed since this plan was saved. The result below uses the latest available data.'));
    if (data.bucket.lastError || !data.bucket.complete || data.stale) panel.append(note(app.gradeNotice(data)));

    const scales = data.scale.filter(([, label]) => label.toUpperCase() !== 'U');
    if (!draft.letter && scales.length) draft.letter = (scales.find(([min]) => min <= 80) ?? scales[0])[1];
    const kind = select([['percentage', 'Percentage'], ['letter', 'Letter grade']], draft.targetType, (choice) => {
      draft.targetType = choice;
      draft.message = '';
      handlers.render();
    });
    const letterOptions = scales.map(([min, label]) => [label, `${label} · ${min}% minimum`]);
    if (draft.letter && !scales.some(([, label]) => label === draft.letter)) letterOptions.unshift([draft.letter, draft.letter + ' (unavailable)']);
    const targetInput = draft.targetType === 'letter' ? select(letterOptions, draft.letter, (value) => {
      draft.letter = value;
      updateDraft();
    }) : numericInput(draft.percentage, 0, 100);
    if (draft.targetType === 'percentage') targetInput.addEventListener('input', () => {
      draft.percentage = readNumber(targetInput);
      updateDraft();
    });
    panel.append(h('div', 'mbgc-form-grid', field('Goal target type', kind),
      field(draft.targetType === 'letter' ? 'Goal letter grade' : 'Goal target (%)', targetInput)));

    const rows = h('div', 'mbgc-goal-rows');
    function editRow(row, index) {
      const sequence = index + 1;
      const assessmentField = (fieldName, control) => {
        const element = field(fieldName, control);
        control.setAttribute('aria-label', `Assessment ${sequence} ${fieldName.toLowerCase()}`);
        return element;
      };
      const remove = button('Remove', () => {
        draft.tasks = draft.tasks.filter((item) => row !== item);
        renderRows();
        updateDraft();
        (rows.querySelector('select') ?? add).focus();
      });
      remove.setAttribute('aria-label', `Remove planned assessment ${sequence}`);
      const rowCategories = [['', 'Select a category'], ...categories.map(([name, weight]) =>
        [name, weight === 0 ? `${name} (0% weight)` : name])];
      if (row.category && !categories.some(([name]) => name === row.category)) rowCategories.push([row.category, row.category + ' (unavailable)']);
      const category = select(rowCategories, row.category, (value) => { row.category = value; updateDraft(); });
      const points = numericInput(row.maxPoints, 0, app.planPointLimit);
      const fixed = numericInput(row.fixed, 0, app.planPointLimit);
      const precision = select([['whole', 'Whole points'], ['decimal', 'Hundredths of a point']], row.precision, (value) => {
        row.precision = value;
        updateDraft();
      });
      points.addEventListener('input', () => { row.maxPoints = readNumber(points); updateDraft(); });
      fixed.placeholder = 'Optional';
      fixed.addEventListener('input', () => {
        row.fixed = fixed.value === '' && !fixed.validity.badInput ? null : fixed.valueAsNumber;
        updateDraft();
      });
      return h('div', 'mbgc-goal-assessment',
        h('div', 'mbgc-goal-heading', h('h3', '', `Planned assessment ${sequence}`), remove),
        h('div', 'mbgc-form-grid mbgc-goal-fields', assessmentField('Category', category), assessmentField('Maximum points', points),
          assessmentField('Fixed score', fixed), assessmentField('Mark precision', precision)));
    }
    const add = button('Add assessment', () => {
      const category = categories.find(([, weight]) => weight > 0)?.[0] ?? '';
      const row = { id: crypto.randomUUID(), category, maxPoints: 100, precision: 'whole', fixed: null };
      draft.tasks.push(row);
      rows.append(editRow(row, draft.tasks.length - 1));
      updateDraft();
      [...rows.querySelectorAll('select')].at(-2)?.focus();
    }, 'plus');
    function renderRows() { rows.replaceChildren(...draft.tasks.map(editRow)); }

    const result = h('div', 'mbgc-goal-result');
    const announcement = h('p', 'mbgc-goal-announcement');
    announcement.setAttribute('aria-live', 'polite');
    const status = h('p', 'mbgc-feedback');
    status.setAttribute('role', 'status');
    const name = h('input', 'mbgc-input');
    Object.assign(name, { type: 'text', maxLength: 100, value: draft.name });
    name.addEventListener('input', () => {
      draft.name = name.value;
      draft.message = '';
      status.textContent = library.error;
      save.disabled = !canSave();
    });
    const save = button(draft.revision ? 'Save changes' : 'Save plan', () => {
      const plan = { id: draft.id, revision: draft.revision, classId: data.classId, termId: data.bucket.termId,
        name: draft.name, source, targetType: draft.targetType, target: draft[draft.targetType], tasks: draft.tasks };
      void persist('save', plan);
    }, null, 'mbgc-primary');
    const start = button('New plan', () => {
      drafts.set(scope, draftOf());
      handlers.render();
    });
    let calculation;
    const canSave = () => Boolean(sync.account && !library.busy && draft.name.trim() && calculation && calculation.state !== 'unavailable');

    function updateDraft() {
      draft.message = '';
      update();
    }
    function update() {
      const target = draft.targetType === 'letter' ? scales.find(([, label]) => label === draft.letter)?.[0] : draft.percentage;
      calculation = app.solveGoalPlan({ tasks: data.tasks, weights: data.weights, method: data.method, future: draft.tasks, target });
      const feedback = paintResult(calculation, data, draft, result);
      announcement.textContent = feedback;
      status.textContent = library.error || draft.message || '';
      save.disabled = !canSave();
      add.disabled = draft.tasks.length >= app.planTaskLimit;
    }
    renderRows();
    panel.append(rows, add, result, announcement, h('div', 'mbgc-goal-saver',
      ...(sync.account ? [field('Plan name', name), save, draft.revision ? start : null] :
        [note('Verify your student account in ManageBac to save this plan.')]), status));
    update();
    return panel;
  }

  function paintResult(plan, data, draft, container) {
    const title = h('h3', '', plan.state === 'impossible' ? 'Impossible under this plan' :
      plan.state === 'achieved' ? 'Already achieved' : plan.state === 'achievable' ? 'Achievable' : 'Plan results');
    const grade = (value) => Number.isFinite(value) ? `${percent(value)} · ${app.letter(value, data.scale) ?? 'Unclassified'}` : 'No grade available';
    const metric = (label, value) => h('div', '', h('span', 'mbgc-field-label', label), h('strong', '', value));
    const current = metric('Current calculated grade', grade(plan.current.percentage));
    const target = metric('Target', Number.isFinite(plan.target) ? grade(plan.target) : 'Enter a target');
    if (plan.state === 'unavailable') {
      container.replaceChildren(title, h('div', 'mbgc-goal-metrics', current, target), note(plan.reason));
      return plan.reason;
    }
    const summary = plan.state === 'impossible'
      ? (plan.currentMeets ? 'Your current grade meets the target. With these planned marks, even the highest available scores fall short.'
        : 'Even the highest available scores on these assessments fall short.')
      : plan.common === null ? 'This plan meets the target without further required marks.'
        : plan.currentMeets ? 'Your current grade meets the target. These scores show how you could maintain it after the planned assessments.'
          : 'These suggested scores meet the target. Other score combinations may also work.';
    const difference = plan.predicted - plan.target;
    const metrics = h('div', 'mbgc-goal-metrics', current, target,
      metric('Common target before rounding', plan.common === null ? '—' : percent(plan.common)),
      metric('Predicted overall', grade(plan.predicted)),
      metric('Maximum under this plan', grade(plan.maximum)),
      metric('Difference from target', `${difference > 0 ? '+' : ''}${number(difference)} pp`));
    const scores = h('ul', 'mbgc-goal-scores', plan.scores.map((row, i) =>
      h('li', '', h('div', '', h('strong', '', `Assessment ${i + 1} · ${row.category}`),
        h('span', 'mbgc-muted', row.fixed !== null ? 'Fixed' : !row.weight ? 'Zero-weight category' :
          plan.state === 'impossible' ? 'Highest available mark' : 'Suggested mark')),
      h('strong', '', `${number(row.earnedPoints)} / ${number(row.maxPoints)}`))));
    const details = h('details', 'mbgc-overrides mbgc-goal-breakdown', h('summary', '', 'Show calculation'));
    details.open = Boolean(draft.details);
    const breakdown = h('div');
    details.append(breakdown);
    function showBreakdown() {
      if (breakdown.childNodes.length) return;
      const points = data.method === 'points';
      const absolute = data.method === 'absolute';
      const total = plan.breakdown.reduce((sum, row) => sum + (row.taskCount && app.validWeight(row.weight) ?
        row.weight * (absolute ? row.taskCount : 1) : 0), 0);
      breakdown.append(note(app.methods[data.method].explanation),
        note(`With the planned assessments included, scoring zero on every unfixed assessment gives ${percent(plan.minimum)}. Scoring full marks gives ${percent(plan.maximum)}.`),
        plan.common === null ? null : note(`The common percentage scales the distance from the zero-score result to the target by the full range of achievable grades. Each suggested mark is rounded up to its chosen precision and checked again.`),
        note(`Active weight denominator: ${number(total)}. ${points ? 'Each category uses total earned points divided by total possible points.' :
          absolute ? 'Each category’s configured weight is multiplied by the number of graded assessments.' :
            'Each category uses the mean of its individual assessment percentages.'}`));
      for (const row of plan.breakdown) {
        const effective = row.taskCount && app.validWeight(row.weight) ? row.weight * (absolute ? row.taskCount : 1) / total * 100 : 0;
        breakdown.append(h('h4', '', row.name), note(`Configured weight ${percent(row.weight)} · Effective weight ${percent(effective)} · Category result ${percent(row.average)}`));
        const existing = plan.base.filter((task) => app.key(task.category) === app.key(row.name));
        const future = plan.scores.map((task, index) => ({ ...task, index })).filter((task) => app.key(task.category) === app.key(row.name));
        if (existing.length || future.length) breakdown.append(h('ul', '',
          existing.map((task) => h('li', '', `${task.title || 'Existing assessment'}: ${number(task.earnedPoints)} / ${number(task.maxPoints)}`)),
          future.map((task) => h('li', '', `Planned assessment ${task.index + 1}: ${number(task.earnedPoints)} / ${number(task.maxPoints)}`))));
      }
    }
    details.addEventListener('toggle', () => {
      draft.details = details.open;
      if (details.open) showBreakdown();
    });
    if (details.open) showBreakdown();
    container.replaceChildren(title, note(summary), metrics, scores, details);
    return summary;
  }

  Object.assign(app, { estimatorTabs, goalPlanner });
})();
