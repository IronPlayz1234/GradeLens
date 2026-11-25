(() => {
  const app = globalThis.MBGC;
  const byId = (id) => document.getElementById(id);
  const fields = [...document.querySelectorAll('[data-setting]')];
  const actions = [...document.querySelectorAll('[data-open]')];
  const system = matchMedia('(prefers-color-scheme: dark)');
  const methodOptions = Object.entries(app.methods).map(([id, method]) => [id, method.label]);
  let settings = app.normalizeSettings();
  let tab;
  let state;
  let rosterKey;
  let inFlight = false;
  const comparison = byId('compare-panel');
  const compareSubject = byId('compare-subject');
  const compareTerm = byId('compare-term');
  const results = byId('compare-results');
  let compareSequence = 0;
  let comparisonKey;
  let selectedTerm = '';
  let comparisonSubjectKey;
  let comparisonTermKey;

  function updateOptions(subjects) {
    comparison.hidden = !settings.compareMethods;
    if (!settings.compareMethods) return;
    const before = compareSubject.value;
    const subjectOptions = subjects.map(([id, name]) => [id, name || 'Class ' + id]);
    const roster = JSON.stringify(subjectOptions);
    if (comparisonSubjectKey !== roster) {
      comparisonSubjectKey = roster;
      options(compareSubject, subjectOptions);
      if (subjectOptions.some(([id]) => id === before)) compareSubject.value = before;
    }
    const choices = [['current', 'Current class term'], ...(state?.terms?.[compareSubject.value] ?? [])];
    const key = JSON.stringify(choices);
    if (comparisonTermKey !== key) { comparisonTermKey = key; options(compareTerm, choices); }
    const preferred = selectedTerm || state?.activeTerm || settings.academicTerm;
    compareTerm.value = choices.some(([id]) => id === preferred) ? preferred : 'current';
    compareSubject.disabled = !subjects.length;
    compareTerm.disabled = !subjects.length;
  }

  function showComparison(data, text) {
    const key = JSON.stringify([data, text]);
    if (comparisonKey === key) return;
    comparisonKey = key;
    if (data) results.replaceChildren(app.comparisonContent(data));
    else {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = text;
      results.replaceChildren(note);
    }
  }

  async function refreshComparison() {
    if (comparison.hidden || !comparison.open) return;
    const sequence = ++compareSequence;
    if (tab?.id == null || !compareSubject.value) {
      showComparison(null, 'Open a signed-in ManageBac tab with available classes.');
      return;
    }
    if (!results.childElementCount) showComparison(null, 'Reading the available term grades…');
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'mbgc:popup-comparison',
        classId: compareSubject.value, term: compareTerm.value }, { frameId: 0 });
      if (sequence !== compareSequence) return;
      showComparison(reply?.value, 'No class grade data is available for this term yet.');
    } catch {
      if (sequence === compareSequence) showComparison(null, 'Could not read this tab. Refresh the ManageBac tab and try again.');
    }
  }

  async function transfer(operation, payload) {
    if (['grades', 'history'].includes(operation) && !tab?.id) throw new Error('Open a signed-in ManageBac tab to export grades.');
    const reply = tab?.id != null ?
      await chrome.tabs.sendMessage(tab.id, { type: 'mbgc:popup-transfer', operation, ...payload }, { frameId: 0 }) :
      await chrome.runtime.sendMessage({ type: 'mbgc:settings-transfer', operation, ...payload });
    if (!reply || reply.error) throw new Error(reply?.error ?? 'GradeLens could not access local storage. Reopen the popup and try again.');
    return reply.value;
  }

  function options(select, entries) {
    select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
  }

  function render() {
    for (const input of fields) {
      const value = settings[input.dataset.setting];
      if (input.type === 'checkbox') input.checked = value;
      else input.value = value;
    }
    const mode = app.modeFor(settings.appearance, system.matches);
    const native = state?.theme;
    const tokens = native?.mode === mode ? native : app.themeTokens(mode, native?.name);
    app.applyTheme(document.documentElement, tokens);
    const subjects = (state?.subjects ?? []).filter(([id]) => /^\d+$/.test(id));
    const key = JSON.stringify(subjects);
    if (key !== rosterKey) {
      rosterKey = key;
      byId('subjects').replaceChildren(...subjects.sort((a, b) => (a[1] ?? '').localeCompare(b[1] ?? '')).map(([id, name]) => {
        const label = document.createElement('label');
        label.className = 'subject-choice';
        const select = document.createElement('select');
        select.dataset.classId = id;
        select.setAttribute('aria-label', name || 'Class ' + id);
        const subjectOptions = methodOptions.map(([value, label]) =>
          [value, value === 'points' ? 'Points-based averaging' : label]);
        options(select, [['', 'Use Global Default'], ...subjectOptions]);
        const title = document.createElement('span');
        title.textContent = name || 'Class ' + id;
        label.append(title, select);
        return label;
      }));
    }
    for (const input of byId('subjects').querySelectorAll('select')) {
      input.value = settings.subjectMethods[input.dataset.classId] ?? '';
      input.title = app.methods[input.value]?.label ?? 'Use Global Default';
    }
    updateOptions(subjects);
    for (const button of actions) button.disabled = !settings.enabled || !state;
    byId('sync').textContent = !state ? 'Open a signed-in ManageBac student tab for subjects and sync status.' :
      !settings.enabled ? 'GradeLens is paused on ManageBac.' :
        state.refreshing ? 'Syncing student-visible grades…' :
          state.issue ? 'Sync needs attention. Open Overall Grades for details.' :
            state.lastSync ? 'Last synced ' + new Date(state.lastSync).toLocaleString() :
              'No grades synced yet. Open Overall Grades to scan.' +
              (state.menuAttached ? '' : ' Sidebar fallback may be in use.');
  }

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      const student = (candidate) => /^https:\/\/uia\.managebac\.com\/student(?:[/?#]|$)/.test(candidate?.url ?? '');
      const available = student(active) ? [active] : await chrome.tabs.query({
        currentWindow: true, url: ['https://uia.managebac.com/student', 'https://uia.managebac.com/student/*']
      });
      tab = available.length === 1 ? available[0] : undefined;
      state = tab?.id != null ? await chrome.tabs.sendMessage(tab.id, { type: 'mbgc:popup-state' }, { frameId: 0 }) : null;
    } catch {
      state = null;
    } finally {
      inFlight = false;
      render();
      void refreshComparison();
    }
  }

  async function save(change) {
    byId('feedback').textContent = '';
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'mbgc:preferences', ...change });
      if (!reply?.value) throw new Error();
    } catch {
      byId('feedback').textContent = 'Could not save preferences. Reopen the popup and try again.';
      render();
    }
  }

  comparison.addEventListener('toggle', () => void refreshComparison());
  compareSubject.addEventListener('change', () => {
    selectedTerm = '';
    render();
    showComparison(null, 'Reading the available term grades…');
    void refreshComparison();
  });
  compareTerm.addEventListener('change', () => {
    selectedTerm = compareTerm.value;
    showComparison(null, 'Reading the available term grades…');
    void refreshComparison();
  });
  byId('transfer-settings').append(app.transferPanel(transfer));
  options(byId('method'), methodOptions);
  byId('version').textContent = 'v' + chrome.runtime.getManifest().version;
  document.addEventListener('change', ({ target }) => {
    const { setting, classId } = target.dataset;
    if (setting) void save({ patch: { [setting]: target.type === 'checkbox' ? target.checked : target.value } });
    if (classId) void save({ subject: { id: classId, method: target.value } });
  });
  for (const button of actions) {
    const glyph = { grades: 'grades', estimator: 'estimator', settings: 'settings' }[button.dataset.open];
    button.prepend(app.icon(glyph));
  }
  for (const button of actions) button.addEventListener('click', async () => {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'mbgc:popup-open', view: button.dataset.open }, { frameId: 0 });
      if (!reply?.opened) throw new Error();
      await chrome.tabs.update(tab.id, { active: true });
      window.close();
    } catch {
      byId('feedback').textContent = 'This view could not be opened. Refresh your ManageBac tab and try again.';
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[app.preferencesKey]) return;
    settings = app.normalizeSettings(changes[app.preferencesKey].newValue);
    render();
    void refresh();
  });
  system.addEventListener('change', render);
  void chrome.storage.local.get(app.preferencesKey).then((result) => {
    settings = app.normalizeSettings(result[app.preferencesKey]);
    return refresh();
  }).catch(() => { byId('feedback').textContent = 'Preferences are unavailable.'; });
  setInterval(refresh, 1800);
})();
