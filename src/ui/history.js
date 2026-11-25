(() => {
  const app = globalThis.MBGC;
  const { h, button, percent, number } = app;
  const labels = {
    baseline: 'Tracking baseline', reconciliation: 'Grade data reconciled',
    'new-grade': 'New grade', 'corrected-grade': 'Score or maximum changed', 'removed-grade': 'Grade no longer counted',
    category: 'Category or eligibility changed', weights: 'Category weights changed', method: 'Calculation method changed',
    scale: 'Letter boundaries changed'
  };
  const timelineDate = (at) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  const note = (message) => h('p', 'mbgc-muted', message);

  function controls(sync, view, classId, render) {
    const history = sync.history;
    const confirmation = classId ?? 'all';
    const root = h('div', 'mbgc-history-actions');
    const messages = view.historyMessages ??= new Map();
    const feedback = h('p', 'mbgc-feedback', messages.get(confirmation));
    feedback.setAttribute('role', 'status');
    async function apply(operation, options) {
      messages.delete(confirmation);
      try { await sync.historyAction(operation, options); }
      catch (error) { messages.set(confirmation, error.message); }
      render();
    }
    if (!sync.account) return note('Verify your student account in ManageBac to track grades.');
    if (!history) return note('Loading locally saved grade history…');
    const toggle = button(history.enabled ? 'Pause grade tracking' : 'Start tracking', () =>
      void apply('enable', { enabled: !history.enabled }));
    root.append(toggle);
    const anyHistory = Object.values(history.terms).some((term) => !classId || classId === term.classId);
    if (anyHistory) {
      const confirming = view.clearHistory === confirmation;
      const clear = button(confirming ? 'Confirm clear history' : classId ? 'Clear subject history' : 'Clear all history', () => {
        if (view.clearHistory !== confirmation) {
          view.clearHistory = confirmation;
          messages.set(confirmation, classId ? 'Clear the history for every term of this subject.' : 'Clear this student’s history for all subjects and terms.');
          render();
          return;
        }
        view.clearHistory = null;
        void apply('clear', { classId, confirmed: true });
      });
      root.append(clear);
      if (confirming) root.append(button('Cancel clear', () => {
        view.clearHistory = null;
        messages.delete(confirmation);
        render();
      }));
    }
    return h('div', '', root, feedback);
  }

  function chart(events) {
    const series = app.historySeries(events);
    const available = series.flat();
    if (!available.length) return null;
    const canvas = h('canvas', 'mbgc-history-chart');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Calculated grade history. ${available.length} observations in ${series.length} separate segments. The timeline shows every value and calculation method.`);
    canvas.dataset.segments = String(series.length);
    canvas.dataset.points = String(available.length);
    canvas.textContent = 'The timeline lists the full grade observations.';
    let resize;
    let appearance;
    function draw() {
      if (!canvas.isConnected) { resize?.disconnect(); appearance?.disconnect(); return; }
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const context = canvas.getContext('2d');
      if (!context) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = bounds.width * ratio;
      canvas.height = bounds.height * ratio;
      context.scale(ratio, ratio);
      const style = getComputedStyle(canvas);
      const color = (name) => style.getPropertyValue('--mbgc-' + name).trim();
      const start = available[0].at;
      const end = available.at(-1).at;
      const left = 39, right = bounds.width - 12, top = 13, bottom = bounds.height - 27;
      const x = (at) => end === start ? (left + right) / 2 : left + (at - start) / (end - start) * (right - left);
      const y = (value) => bottom - value / 100 * (bottom - top);
      context.font = '11px system-ui, sans-serif';
      context.fillStyle = color('muted');
      context.strokeStyle = color('border');
      context.lineWidth = 1;
      context.textBaseline = 'middle';
      for (const step of [0, 25, 50, 75, 100]) {
        context.fillText(step + '%', 1, y(step));
        context.beginPath();
        context.moveTo(left, y(step));
        context.lineTo(right, y(step));
        context.stroke();
      }
      const dates = new Intl.DateTimeFormat(undefined, end > start && end - start < 86400000
        ? { hour: 'numeric', minute: '2-digit', ...(end - start < 60000 ? { second: '2-digit' } : {}) } : { month: 'short', day: 'numeric', ...(end - start > 31557600000 ? { year: '2-digit' } : {}) });
      context.fillText(dates.format(start), left, bounds.height - 10);
      if (end !== start) {
        context.textAlign = 'right';
        context.fillText(dates.format(end), right, bounds.height - 10);
      }
      context.strokeStyle = color('ink');
      context.fillStyle = color('ink');
      context.lineWidth = 2;
      for (const segment of series) {
        context.beginPath();
        for (const [index, event] of segment.entries()) {
          context[index ? 'lineTo' : 'moveTo'](x(event.at), y(event.percentage));
        }
        context.stroke();
        for (const event of segment) {
          const pointX = x(event.at);
          const pointY = y(event.percentage);
          if (event.previousId) {
            context.beginPath();
            context.arc(pointX, pointY, 3, 0, Math.PI * 2);
            context.fill();
          } else context.strokeRect(pointX - 3, pointY - 3, 6, 6);
        }
      }
      const latest = available.at(-1);
      context.textAlign = 'right';
      context.fillText(percent(latest.percentage), right - 6, Math.max(9, y(latest.percentage) - 9));
    }
    requestAnimationFrame(() => {
      if (!canvas.isConnected) return;
      resize = new ResizeObserver(draw);
      resize.observe(canvas);
      const stage = canvas.closest('.mbgc-stage');
      if (stage) {
        appearance = new MutationObserver(draw);
        appearance.observe(stage, { attributes: true, attributeFilter: ['data-theme', 'style'] });
      }
      draw();
    });
    return canvas;
  }

  function historyPanel(sync, data, view, render) {
    const scope = app.historyKey(data.classId, data.bucket?.termId);
    const open = view.openHistory ??= new Set();
    const details = h('details', 'mbgc-overrides mbgc-history', h('summary', '', 'Grade History & Trends'));
    details.open = open.has(data.classId);
    function populate() {
      if (details.childElementCount > 1) return;
      const body = h('div', 'mbgc-history-body');
      const history = sync.history;
      const term = data.verified && history?.terms[scope];
      const events = term?.events ?? [];
      const startedAt = term?.startedAt ?? history?.startedAt;
      if (startedAt) body.append(note('Tracking started ' + timelineDate(startedAt) + (term ? '' : ' for this student') + '.'));
      if (term?.dropped) body.append(note(term.dropped + ' older observations were removed by local retention.'));
      if (!data.verified) body.append(note('Choose a verified academic term to view this subject’s history.'));
      else if (!events.length) body.append(note(history?.enabled ?
        'Grade tracking has started. Your history will appear here as new grades are recorded.' :
        'There are no recorded grades for this term.'));
      else {
        if (events.length === 1 && history.enabled) body.append(note('Grade tracking has started. Your history will appear here as new grades are recorded.'));
        body.append(chart(events), note('Squares start a comparison segment. Dots show recorded assessment changes.'));
        const timeline = h('ol', 'mbgc-history-timeline');
        for (const event of events) {
          const time = h('time', '', timelineDate(event.at));
          time.dateTime = new Date(event.at).toISOString();
          const grade = event.percentage === null ? 'No grade available' :
            percent(event.percentage) + (event.letter ? ' · ' + event.letter : '');
          const change = event.delta === null ? '' : event.delta === 0 ? ' · No percentage change' :
            ' · ' + (event.delta > 0 ? '+' : '−') + number(Math.abs(event.delta)) + ' pp';
          const points = (score) => score ? number(score.points) + ' / ' + number(score.maximum) +
            (score.category ? ' · ' + score.category : '') + (score.excluded ? ' · Excluded' : '') : 'No numeric mark';
          const changes = event.changes.length ? h('ul', '', event.changes.map((item) =>
            h('li', '', h('strong', '', item.title), ' · ' + points(item.before) + ' → ' + points(item.after)))) : null;
          timeline.append(h('li', '', time, h('strong', '', event.kinds.map((kind) => labels[kind]).join(' · ')),
            note(grade + change + ' · ' + app.methods[event.method].label + ' · ' + event.count + ' graded'),
            !event.complete ? note('This observation used the available scores from a partial list.') : null,
            changes, event.additionalChanges ? note(event.additionalChanges + ' further assessment changes were observed.') : null));
        }
        body.append(timeline);
      }
      if (history?.issue) body.append(note(history.issue));
      body.append(controls(sync, view, data.classId, render));
      details.append(body);
    }
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open) {
        const newlyOpened = !open.has(data.classId);
        open.add(data.classId);
        populate();
        if (newlyOpened && sync.account) void sync.historyAction('get').catch(() => {});
      } else open.delete(data.classId);
    });
    if (details.open) populate();
    return details;
  }
  Object.assign(app, { historyPanel, historyControls: controls });
})();
