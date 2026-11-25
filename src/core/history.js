(() => {
  const app = globalThis.MBGC;
  const version = 1;
  const eventLimit = 120;
  const detailLimit = 60;
  const historySize = 750000;
  const classId = (value) => typeof value === 'string' && /^\d{1,30}$/.test(value);
  const termId = (value) => typeof value === 'string' && /^[\w.-]{1,80}$/.test(value) &&
    !/^(?:all|unknown|0|-1|default)$/i.test(value);
  const key = (id, term) => id + ':' + term;
  const emptyHistory = () => ({ version, enabled: false, startedAt: null, terms: {} });
  const text = (value, length) => typeof value === 'string' && value.length <= length;
  const date = (value) => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const kinds = ['baseline', 'reconciliation', 'new-grade', 'corrected-grade', 'removed-grade',
    'category', 'weights', 'method', 'scale'];
  const performanceKinds = ['new-grade', 'corrected-grade', 'removed-grade'];
  const assessmentKinds = [...performanceKinds, 'category'];
  const scored = (bucket) => Object.values(bucket?.records ?? {}).filter(app.validScore)
    .map(({ id, title, category, earnedPoints, maxPoints, excluded }) =>
      ({ id, title, category: category ?? '', earnedPoints, maxPoints, excluded: Boolean(excluded) }))
    .filter((item) => text(item.id, 80) && item.id.length).sort((a, b) => compare(a.id, b.id));
  function fingerprint(value) {
    let a = 2166136261, b = 1779033703;
    const raw = JSON.stringify(value);
    for (let i = 0; i < raw.length; i++) {
      a = Math.imul(a ^ raw.charCodeAt(i), 16777619);
      b = Math.imul(b ^ raw.charCodeAt(i), 1597334677);
    }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  }
  const signature = (rows) => fingerprint(rows.map((row) =>
    [row.id, app.key(row.category), row.earnedPoints, row.maxPoints, row.excluded]));

  function gradeChanges(before, after, bucket) {
    const old = new Map(before.map((row) => [row.id, row]));
    const changes = [];
    const mark = (previous, next, types) => {
      if (!types.length) return;
      const item = next ?? previous;
      const info = (row) => row && { points: row.earnedPoints, maximum: row.maxPoints, category: row.category.slice(0, 180), excluded: row.excluded };
      changes.push({ id: item.id, title: (item.title || 'Assessment ' + item.id).slice(0, 180),
        kinds: types, before: info(previous), after: info(next) });
    };
    let uncertain = false;
    for (const row of after) {
      const previous = old.get(row.id);
      old.delete(row.id);
      if (!previous) {
        mark(null, row, ['new-grade']);
        continue;
      }
      const types = [];
      if (previous.earnedPoints !== row.earnedPoints || previous.maxPoints !== row.maxPoints) types.push('corrected-grade');
      if (app.key(previous.category) !== app.key(row.category) || previous.excluded !== row.excluded) types.push('category');
      mark(previous, row, types);
    }
    for (const row of old.values()) {
      if (!bucket.complete && !bucket.records?.[row.id]?.explicitlyUngraded) uncertain = true;
      else mark(row, null, ['removed-grade']);
    }
    return { changes, uncertain };
  }

  function trimHistory(history) {
    const entries = [];
    let bytes = 0;
    for (const term of Object.values(history.terms)) {
      const extra = Math.max(0, term.events.length - eventLimit);
      if (extra) { term.events.splice(0, extra); term.dropped += extra; }
      for (const event of term.events) {
        const size = JSON.stringify(event).length;
        entries.push({ term, event, size });
        bytes += size;
      }
    }
    if (bytes <= historySize) return;
    entries.sort((a, b) => a.event.at - b.event.at);
    for (const { term, event, size } of entries) {
      if (bytes <= historySize) break;
      term.events.splice(term.events.indexOf(event), 1);
      term.dropped++;
      bytes -= size;
    }
  }

  function observeHistory(history, cache, settings, overrides, { at, beforeCache = cache, ids = Object.keys(cache.classes), reset = false }) {
    if (!history.enabled) return false;
    let written = false;
    for (const id of ids) {
      const subject = cache.classes[id];
      if (!classId(id) || !subject) continue;
      for (const [termKey, bucket] of Object.entries(subject.terms)) {
        const term = bucket.termId;
        if (!termId(term)) continue;
        const scope = key(id, term);
        const current = history.terms[scope];
        const data = app.gradeInputs(cache, settings, overrides, id, termKey);
        const rows = scored(bucket);
        const sig = signature(rows);
        const basis = {
          method: data.method,
          weights: fingerprint(Object.entries(data.weights).map(([name, value]) => [app.key(name), value]).sort(([a], [b]) => compare(a, b))),
          scale: fingerprint(data.scale)
        };
        const previous = current?.checkpoint;
        const epoch = cache.clearedAt ?? 0;
        const latest = current?.events.at(-1);
        if (previous && !reset && previous.epoch === epoch && previous.fingerprint === sig &&
            previous.method === basis.method && previous.weights === basis.weights && previous.scale === basis.scale) continue;

        const result = app.estimate({ ...data, tasks: data.tasks.sort((a, b) => String(a.title ?? '').localeCompare(b.title ?? '')) }, data.method);
        const percentage = Number.isFinite(result.percentage) ? result.percentage : null;
        if (!previous && !reset && latest && latest.at <= at && latest.fingerprint === sig && latest.method === basis.method &&
            latest.weightFingerprint === basis.weights && latest.scaleFingerprint === basis.scale && latest.count === result.count &&
            (latest.percentage === percentage || (latest.percentage !== null && percentage !== null && Math.abs(latest.percentage - percentage) <= 1e-12))) {
          // A restored point already records these exact inputs. Resume its
          // checkpoint without writing a duplicate observation.
          current.checkpoint = { id: latest.id, at: latest.at, epoch, fingerprint: sig, ...basis, percentage: latest.percentage };
          written = true;
          continue;
        }
        if (!current && percentage === null) continue;
        if (reset && percentage === null) {
          if (current?.checkpoint) { current.checkpoint = null; written = true; }
          continue;
        }
        let labels = [];
        let observations = [];
        if (!current) labels = ['baseline'];
        else if (!previous || reset || previous.epoch !== epoch) labels = ['reconciliation'];
        else {
          if (previous.method !== basis.method) labels.push('method');
          if (previous.weights !== basis.weights) labels.push('weights');
          if (previous.scale !== basis.scale) labels.push('scale');
          if (previous.fingerprint !== sig) {
            const before = scored(beforeCache.classes[id]?.terms[termKey]);
            if (signature(before) !== previous.fingerprint) labels.push('reconciliation');
            else {
              const { changes, uncertain } = gradeChanges(before, rows, bucket);
              observations = changes;
              labels.push(...new Set(changes.flatMap((item) => item.kinds)));
              if (uncertain || !changes.length) labels.push('reconciliation');
            }
          }
        }
        if (!labels.length) continue;
        const eventId = crypto.randomUUID();
        const point = { percentage, letter: app.letter(percentage, data.scale)?.slice(0, 180) ?? null, count: result.count };
        const comparable = Boolean(previous && previous.at <= at && labels.every((item) => performanceKinds.includes(item)));
        const event = { id: eventId, at, method: basis.method, ...point, fingerprint: sig,
          weightFingerprint: basis.weights, scaleFingerprint: basis.scale,
          kinds: labels, complete: Boolean(bucket.complete), previousId: comparable ? previous.id : null,
          delta: comparable && previous.percentage !== null && percentage !== null ? percentage - previous.percentage : null,
          changes: observations.slice(0, detailLimit), additionalChanges: Math.max(0, observations.length - detailLimit) };
        const item = current ?? { classId: id, termId: term, subject: '', term: '', startedAt: at, dropped: 0, events: [] };
        item.subject = data.title.slice(0, 250);
        item.term = data.label.slice(0, 250);
        item.startedAt = Math.min(item.startedAt, at);
        item.events.push(event);
        item.events.sort((a, b) => a.at - b.at);
        item.checkpoint = { id: eventId, at, epoch, fingerprint: sig, ...basis, percentage };
        history.terms[scope] = item;
        written = true;
      }
    }
    if (written) trimHistory(history);
    return written;
  }

  function historySeries(events) {
    const segments = [];
    let segment = null;
    for (const event of events) {
      if (!Number.isFinite(event.percentage)) { segment = null; continue; }
      const previous = segment?.at(-1);
      if (!previous || event.previousId !== previous.id || event.method !== previous.method ||
          !event.kinds.every((kind) => performanceKinds.includes(kind))) {
        segment = [];
        segments.push(segment);
      }
      segment.push(event);
    }
    return segments;
  }

  function archiveHistory(history, owner) {
    return { format: 'gradelens-history', version, exportedAt: new Date().toISOString(), ...(owner ? { owner } : {}),
      startedAt: history.startedAt,
      terms: Object.values(history.terms).map(({ checkpoint, ...term }) => term) };
  }

  function readHistoryArchive(input) {
    const invalid = () => { throw new Error('Invalid GradeLens history in this backup.'); };
    const id = (value) => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
    const method = (value) => typeof value === 'string' && Object.hasOwn(app.methods, value);
    const count = (value) => Number.isSafeInteger(value) && value >= 0;
    const selectKinds = (value, list) => Array.isArray(value) && value.length > 0 &&
      value.every((kind) => list.includes(kind)) && new Set(value).size === value.length;
    const optionalLabel = (value) => value === null || text(value, 180);
    const digest = (value) => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
    const score = (value) => value === null ? null :
      value && app.validScore({ earnedPoints: value.points, maxPoints: value.maximum }) &&
      text(value.category, 180) && typeof value.excluded === 'boolean' ?
        { points: value.points, maximum: value.maximum, category: value.category, excluded: value.excluded } : invalid();
    if (input?.format !== 'gradelens-history' || input.version !== version) throw new Error('This history format version is unsupported.');
    if (!/^[a-f0-9]{64}$/.test(input.owner ?? '') || typeof input.owner !== 'string' ||
        !(input.startedAt === null || date(input.startedAt)) || !Array.isArray(input.terms) ||
        typeof input.exportedAt !== 'string' || !Number.isFinite(Date.parse(input.exportedAt))) invalid();
    const scopes = new Set();
    const seen = new Set();
    const terms = input.terms.map((term) => {
      if (!term || !classId(term.classId) || !termId(term.termId) || !text(term.subject, 250) || !text(term.term, 250) ||
          !date(term.startedAt) || !count(term.dropped) || !Array.isArray(term.events) || term.events.length > eventLimit) invalid();
      const scope = key(term.classId, term.termId);
      if (scopes.has(scope)) invalid();
      scopes.add(scope);
      const events = term.events.map((event) => {
        if (!event || !id(event.id) || seen.has(event.id) || !date(event.at) || event.at < term.startedAt ||
            !method(event.method) || !(event.percentage === null || (Number.isFinite(event.percentage) && event.percentage >= 0 && event.percentage <= 100.000000000001)) ||
            !optionalLabel(event.letter) || !count(event.count) || !digest(event.fingerprint) ||
            (event.weightFingerprint != null && !digest(event.weightFingerprint)) ||
            (event.scaleFingerprint != null && !digest(event.scaleFingerprint)) || !selectKinds(event.kinds, kinds) || typeof event.complete !== 'boolean' ||
            !(event.previousId === null || (id(event.previousId) && event.previousId !== event.id)) ||
            !(event.delta === null || (Number.isFinite(event.delta) && Math.abs(event.delta) <= 100.000000000001)) ||
            !Array.isArray(event.changes) || event.changes.length > detailLimit || !count(event.additionalChanges)) invalid();
        seen.add(event.id);
        const changes = event.changes.map((item) => {
          if (!item || !text(item.id, 80) || !item.id.length || !text(item.title, 180) || !selectKinds(item.kinds, assessmentKinds)) invalid();
          const before = score(item.before);
          const after = score(item.after);
          if (!before && !after) invalid();
          return { id: item.id, title: item.title, kinds: [...item.kinds], before, after };
        });
        return { id: event.id, at: event.at, method: event.method, percentage: event.percentage, letter: event.letter,
          count: event.count, fingerprint: event.fingerprint,
          weightFingerprint: event.weightFingerprint ?? null, scaleFingerprint: event.scaleFingerprint ?? null, kinds: [...event.kinds], complete: event.complete,
          previousId: event.previousId, delta: event.delta, changes, additionalChanges: event.additionalChanges };
      });
      const byId = new Map(events.map((event) => [event.id, event]));
      for (const event of events) {
        if ((event.previousId || event.delta !== null) && !event.kinds.every((kind) => performanceKinds.includes(kind))) invalid();
        if (!event.previousId && event.delta !== null) invalid();
        const prior = byId.get(event.previousId);
        if (!prior) continue;
        if (prior.at > event.at || prior.method !== event.method) invalid();
        const expected = prior.percentage === null || event.percentage === null ? null : event.percentage - prior.percentage;
        if (expected !== event.delta) invalid();
      }
      return { classId: term.classId, termId: term.termId, subject: term.subject,
        term: term.term, startedAt: term.startedAt, dropped: term.dropped, events };
    });
    return { format: input.format, version, owner: input.owner, startedAt: input.startedAt, terms, exportedAt: input.exportedAt };
  }

  function mergeHistory(history, archive, scope) {
    const next = structuredClone(history);
    const seen = new Set(Object.values(next.terms).flatMap((term) => term.events.map((event) => event.id)));
    let available = historySize - Object.values(next.terms).flatMap((term) => term.events)
      .reduce((total, event) => total + JSON.stringify(event).length, 0);
    let added = 0;
    let skipped = 0;
    let full = 0;
    for (const term of archive.terms) {
      const id = key(term.classId, term.termId);
      if (!(scope[term.classId]?.includes(term.termId) || Object.hasOwn(next.terms, id))) {
        skipped += term.events.length;
        continue;
      }
      const existing = next.terms[id];
      const accepted = new Set();
      for (const event of [...term.events].sort((a, b) => b.at - a.at)) {
        if (seen.has(event.id)) continue;
        const size = JSON.stringify(event).length;
        if ((existing?.events.length ?? 0) + accepted.size >= eventLimit || size > available) {
          full++;
          continue;
        }
        available -= size;
        seen.add(event.id);
        accepted.add(event.id);
      }
      if (!accepted.size) continue;
      const incoming = term.events.filter((event) => accepted.has(event.id));
      next.terms[id] = { ...(existing ?? term), startedAt: Math.min(existing?.startedAt ?? term.startedAt, term.startedAt),
        dropped: Math.max(existing?.dropped ?? 0, term.dropped),
        events: [...(existing?.events ?? []), ...incoming].sort((a, b) => a.at - b.at) };
      added += incoming.length;
    }
    if (added && archive.startedAt) next.startedAt = Math.min(next.startedAt ?? archive.startedAt, archive.startedAt);
    return { history: next, added, skipped, full };
  }

  function historyCSV(archive) {
    const output = ['subject,class_id,term,term_id,observed_at,method,percentage,letter,graded_count,change_kinds,percentage_point_change,assessment_changes'];
    for (const term of archive.terms) {
      for (const event of term.events) {
        output.push([term.subject, term.classId, term.term, term.termId, new Date(event.at).toISOString(),
          app.methods[event.method].label, event.percentage, event.letter, event.count, event.kinds.join('|'), event.delta,
          JSON.stringify({ listed: event.changes, additionalCount: event.additionalChanges })].map(app.csvCell).join(','));
      }
    }
    return '\uFEFF' + output.join('\r\n') + '\r\n';
  }

  Object.assign(app, { emptyHistory, historyKey: key, observeHistory, historySeries, archiveHistory, readHistoryArchive, mergeHistory, historyCSV });
})();
