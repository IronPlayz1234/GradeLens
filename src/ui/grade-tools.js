(() => {
  const app = globalThis.MBGC;
  const percent = (value) => value.toFixed(2) + '%';
  function element(tag, text, classes) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (classes) node.className = classes;
    return node;
  }

  function comparisonContent(data) {
    const section = element('div', null, 'gl-comparison');
    section.append(element('p', data.title + ' · ' + data.term, 'gl-tool-note'));
    const grid = element('div', null, 'gl-comparison-grid');
    for (const row of data.rows) {
      const card = element('div', null, 'gl-comparison-method');
      if (row.active) card.dataset.selected = '';
      const title = element('strong', row.label, 'gl-comparison-label');
      const value = element('div', row.percentage === null ? 'Unavailable' :
        percent(row.percentage) + (row.letter ? ' · ' + row.letter : ''), 'gl-comparison-score');
      const delta = row.delta === null ? '' :
        Math.abs(row.delta) < .005 ? 'Same estimate' : (row.delta > 0 ? '+' : '−') + Math.abs(row.delta).toFixed(2) + ' pp vs selected';
      card.append(title, value, element('small', row.active ? 'Selected method' : delta, 'gl-tool-note'));
      grid.append(card);
    }
    section.append(grid);
    if (data.notice) section.append(element('p', data.notice, 'gl-tool-note'));
    section.append(element('p', app.estimateNotice, 'gl-tool-note'));
    return section;
  }

  function download(text, type, name) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = element('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const filename = (kind, suffix) => 'gradelens-' + kind + '-' + new Date().toISOString().slice(0, 10) + '.' + suffix;

  async function exportReport(request, kind, history = false) {
    const report = await request(history ? 'history' : 'grades');
    if (history ? !report.terms.some((term) => term.events.length) : !report.subjects.length) {
      throw new Error(history ? 'There are no grade history observations to export yet.' :
        'No grade data is available to export. Open Overall Grades to sync.');
    }
    const file = history ? 'history' : 'grades';
    const csv = history ? app.historyCSV : app.gradeCSV;
    if (kind === 'csv') download(csv(report), 'text/csv;charset=utf-8', filename(file, 'csv'));
    else download(JSON.stringify(report, null, 2), 'application/json', filename(file, 'json'));
  }

  function gradeExportMenu(request, state, repaint) {
    const menu = element('details', null, 'gl-quick-export');
    menu.classList.add('mbgc-button');
    menu.open = Boolean(state.open);
    menu.addEventListener('toggle', () => { if (menu.isConnected) state.open = menu.open; });
    const options = element('div', null, 'gl-quick-export-options');
    options.append(element('p', 'Grade files contain private academic information.', 'gl-tool-note'));
    const status = element('p', state.status, 'gl-tool-note');
    status.setAttribute('role', 'status');
    for (const [kind, label] of [['csv', 'Download grade CSV'], ['json', 'Download grade JSON']]) {
      const button = element('button', label, 'mbgc-button');
      button.type = 'button';
      button.disabled = Boolean(state.busy);
      button.addEventListener('click', async () => {
        if (state.busy) return;
        state.busy = true;
        options.querySelectorAll('button').forEach((item) => { item.disabled = true; });
        try { await exportReport(request, kind); state.status = 'Grade export downloaded.'; }
        catch (error) { state.status = error.message; }
        finally {
          status.textContent = state.status;
          state.busy = false;
          options.querySelectorAll('button').forEach((item) => { item.disabled = false; });
          repaint();
        }
      });
      options.append(button);
    }
    options.append(status);
    menu.append(element('summary', 'Export'), options);
    return menu;
  }

  function previewText(preview) {
    const list = [];
    const keys = { enabled: 'Extension enabled', appearance: 'Appearance', method: 'Global method',
      compareMethods: 'Method comparison', refreshMinutes: 'Refresh interval (minutes)', density: 'Card density',
      motion: 'Animation intensity', showGrades: 'Overall Grades', showEstimator: 'Grade Estimator',
      showBadges: 'Sidebar grade badges', showOverview: 'Class Overview cards', showTasks: 'Class Tasks cards',
      progressBars: 'Progress bars', welcomeSeen: 'Welcome guide seen' };
    const settings = Object.entries(preview.settings).map(([key, value]) => {
      const display = typeof value === 'boolean' ? (value ? 'On' : 'Off') : app.methods[value]?.label ?? value;
      return (keys[key] ?? key) + ' · ' + display;
    });
    if (preview.term) settings.push('Academic term · ' + (preview.term === 'current' ? 'Current class terms' : preview.term.slice(5)));
    if (settings.length) list.push('Replace these preferences: ' + settings.join(', ') + '.');
    if (preview.replaceMethods) list.push(`Replace subject method settings for ${preview.matchingClasses} matching classes (${preview.methodCount} explicit overrides).`);
    const actions = {
      weights: `Replace category weights for matching classes (${preview.weightCount} overrides in the file).`,
      scale: 'Replace the student’s custom letter boundaries.',
      predictions: `Replace saved predictions for matching terms (${preview.predictionCount} predictions in the file).`,
      goalPlans: `Replace saved goal plans for matching terms (${preview.goalCount} plans in the file).`
    };
    for (const section of preview.sections) list.push(actions[section]);
    if (preview.skippedClasses || preview.skippedTerms) list.push(`Unavailable in this account: ${preview.skippedClasses} classes and ${preview.skippedTerms} class terms. Their data will be skipped.`);
    if (preview.termSkipped) list.push('The backed-up academic term is unavailable. The current selection will be kept.');
    if (preview.studentSkipped) list.push('Student-specific settings can be restored from a verified account at the same school.');
    if (preview.history) list.push(preview.history.matched ?
      `Merge ${preview.history.added} grade history observations and keep existing history.` +
        (preview.history.skipped ? ` ${preview.history.skipped} observations belong to unavailable terms.` : '') +
        (preview.history.full ? ` ${preview.history.full} observations exceed available history space.` : '') :
      'Grade history belongs to a different or unavailable student account and will be skipped.');
    if (!list.length) list.push('There are no matching settings to restore.');
    return list;
  }

  function transferPanel(request, state = {}, onChange) {
    const details = element('details', null, 'gl-transfer');
    details.open = Boolean(state.open);
    details.addEventListener('toggle', () => { if (details.isConnected) state.open = details.open; });
    const body = element('div', null, 'gl-transfer-body');
    const feedback = element('p', state.feedback, 'gl-tool-note');
    feedback.setAttribute('role', 'status');
    const review = element('div', null, 'gl-transfer-review');
    review.tabIndex = -1;
    review.setAttribute('aria-label', 'Settings restore preview');
    const actions = element('div', null, 'gl-transfer-actions');
    const file = element('input');
    Object.assign(file, { type: 'file', accept: '.json,application/json', hidden: true });
    file.setAttribute('aria-label', 'Select GradeLens settings backup');
    const picker = action('Restore Settings', () => { file.value = ''; file.click(); });
    function notice(text) {
      state.feedback = text;
      feedback.textContent = text;
    }
    function action(label, fn) {
      const button = element('button', label, 'mbgc-button');
      button.type = 'button';
      button.disabled = Boolean(state.busy);
      button.addEventListener('click', fn);
      return button;
    }
    async function run(operation, success) {
      if (state.busy) return;
      state.busy = true;
      details.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      notice('');
      try {
        const message = await operation();
        notice(message ?? success);
      } catch (error) {
        notice(error.message);
      } finally {
        state.busy = false;
        details.querySelectorAll('button').forEach((button) => { button.disabled = false; });
        onChange?.();
      }
    }

    function drawPreview() {
      review.replaceChildren();
      if (!state.preview) return;
      const preview = state.preview;
      const header = element('strong', 'Review settings restore');
      const list = element('ul');
      for (const entry of previewText(preview)) list.append(element('li', entry));
      const confirm = action('Confirm restore', () => {
        void run(async () => {
          try { await request('restore', { token: preview.token }); }
          finally { state.preview = null; drawPreview(); }
        }, 'Settings restored. Open ManageBac tabs update automatically.');
      });
      const cancel = action('Cancel restore', () => {
        state.preview = null;
        drawPreview();
        notice('Restore cancelled.');
        picker.focus();
      });
      const choices = element('div', null, 'gl-transfer-actions');
      choices.append(confirm, cancel);
      review.append(header,
        element('p', 'Backup from ' + preview.school + ' · ' + new Date(preview.exportedAt).toLocaleString(), 'gl-tool-note'),
        list, element('p', 'Grades and nonmatching classes and terms will be kept.', 'gl-tool-note'), choices);
      review.scrollTop = 0;
    }

    const historyOption = element('input');
    Object.assign(historyOption, { type: 'checkbox', checked: Boolean(state.includeHistory) });
    historyOption.addEventListener('change', () => { state.includeHistory = historyOption.checked; });
    const includeHistory = element('label', null, 'gl-backup-history');
    includeHistory.append(historyOption, 'Include grade history in backup');
    actions.append(action('Export Grades as CSV', () => void run(() => exportReport(request, 'csv'), 'CSV grade export downloaded.')),
      action('Export Grades as JSON', () => void run(() => exportReport(request, 'json'), 'JSON grade export downloaded.')),
      action('Export Grade History as CSV', () => void run(() => exportReport(request, 'csv', true), 'CSV history export downloaded.')),
      action('Export Grade History as JSON', () => void run(() => exportReport(request, 'json', true), 'JSON history export downloaded.')),
      action('Back Up Settings', () => void run(async () => {
        const backup = await request('backup', { includeHistory: Boolean(state.includeHistory) });
        download(JSON.stringify(backup, null, 2), 'application/json', filename('settings', 'json'));
        return backup.history ? 'Settings and grade history backup downloaded.' : backup.student ? 'Settings backup downloaded.' :
          'Preferences backed up. Open a verified ManageBac tab to include student overrides and saved scenarios.';
      })), picker);
    file.addEventListener('change', () => {
      if (!file.files.length) return;
      const selected = file.files[0];
      state.preview = null;
      drawPreview();
      void run(async () => {
        if (selected.size > 10 * 1024 * 1024) throw new Error('This backup is larger than the extension’s settings storage limit.');
        let json;
        try { json = JSON.parse(await selected.text()); }
        catch { throw new Error('This file is not valid JSON. Choose a GradeLens settings backup.'); }
        const backup = app.readBackup(json);
        state.preview = await request('preview', { backup });
        drawPreview();
      }, 'Review the proposed settings before confirming.').then(() => {
        if (details.isConnected && state.preview) review.focus();
      });
    });
    body.append(element('p', 'Grade exports contain private academic information. Share them only with people you trust.', 'gl-tool-note'),
      actions, includeHistory, file, review, feedback);
    details.append(element('summary', 'Export & Backup'), body);
    drawPreview();
    return details;
  }

  Object.assign(app, { comparisonContent, transferPanel, gradeExportMenu });
})();
