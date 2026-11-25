(() => {
  const app = globalThis.MBGC;
  const settingsDefaults = {
    method: 'percentage', refreshMinutes: 5, density: 'comfortable', progressBars: true, motion: 'full', welcomeSeen: false
  };
  const freshCache = () => ({ classes: {}, sources: [], sourceChecks: {}, lastSync: null, revision: 0, clearedAt: 0 });
  const currentTerms = 'current';
  const termKey = (id) => id ? 'term:' + id : 'unknown';
  const hasGrades = (bucket) => Number.isInteger(bucket?.gradedCount) ? bucket.gradedCount > 0 :
    Object.values(bucket?.records ?? {}).some((task) => app.validScore(task) && !task.excluded);

  function classTermKey(subject, nativeTerm = null) {
    if (nativeTerm) return termKey(nativeTerm);
    const pointers = [subject?.selectedTerm, subject?.defaultTerm].filter(Boolean);
    for (const pointer of pointers) {
      const bucket = subject.terms[termKey(pointer.id)];
      if (bucket && (hasGrades(bucket) || (pointer === subject.selectedTerm && bucket.complete))) return termKey(pointer.id);
    }
    const usable = Object.entries(subject?.terms ?? {}).filter(([, bucket]) => bucket.termId && hasGrades(bucket));
    if (usable.length === 1) return usable[0][0];
    if (pointers.length) return termKey(pointers[0].id);
    const available = Object.entries(subject?.terms ?? {}).filter(([, bucket]) => bucket.termId && bucket.lastScan);
    return available.length === 1 ? available[0][0] : 'unknown';
  }

  function mergeScan(cache, snapshot) {
    const { records, classes, context, term, weights, scale, at, incremental } = snapshot;
    const classList = context.type === 'tasks';
    const detail = context.type === 'task' && snapshot.completeRecord;
    const rendered = snapshot.visible || snapshot.sourceKind === 'rendered';
    const source = rendered ? 'rendered' : 'background';
    const previousTerm = cache.classes[context.classId]?.terms[termKey(term.id)];
    const authoritative = Boolean(classList && term.id && snapshot.complete && !incremental &&
      (snapshot.visible || records.length || !Object.keys(previousTerm?.records ?? {}).length) &&
      records.every((task) => task.classId === context.classId && task.termId === term.id));
    const verifiedEdit = Boolean(incremental && snapshot.visible && snapshot.complete);
    if (snapshot.sources.length) cache.sources = [...new Set([...cache.sources, ...snapshot.sources])].slice(-300);
    const ensureClass = (classId) => cache.classes[classId] ??= { name: '', terms: {} };
    for (const [classId, name] of Object.entries(classes)) {
      const subject = ensureClass(classId);
      if (name) subject.name = name;
    }
    const ensureTerm = (classId, termId, label) => {
      const subject = ensureClass(classId);
      const bucket = subject.terms[termKey(termId)] ??= {
        label, termId, records: {}, weights: {}, scale: null, lastScan: null, complete: false, weightScan: 0
      };
      if (label && (!bucket.label || bucket.label.startsWith('Term ') || bucket.label === 'Selected academic term')) bucket.label = label;
      return bucket;
    };
    const visited = new Map();
    const touch = (bucket) => {
      if (!visited.has(bucket)) visited.set(bucket, { ids: new Set(), preserved: false, read: false });
      return visited.get(bucket);
    };
    if (context.classId && !incremental) {
      const bucket = ensureTerm(context.classId, term.id, term.label);
      if (classList && term.id) {
        const subject = ensureClass(context.classId);
        if (authoritative) touch(bucket).read = true;
        const field = snapshot.visible ? 'selectedTerm' : snapshot.defaultTerm ? 'defaultTerm' : null;
        const incoming = records.some((task) => task.classId === context.classId && task.termId === term.id && app.validScore(task));
        const prior = subject.terms[classTermKey(subject)];
        if (field && !snapshot.loading && at >= (subject[field]?.at ?? 0) &&
          (incoming || (authoritative && snapshot.visible) || !hasGrades(prior))) {
          subject[field] = { id: term.id, at };
        }
        if (!snapshot.loading && Object.keys(weights).length && at >= bucket.weightScan) {
          const patch = Object.fromEntries(Object.entries(weights).filter(([name, value]) =>
            authoritative || !Object.hasOwn(bucket.weights, name) || bucket.weights[name] === value));
          if (Object.keys(patch).length) {
            bucket.weights = { ...bucket.weights, ...patch };
            bucket.weightScan = at;
          }
        }
      }
      if (scale && at >= (bucket.scaleAt ?? 0)) {
        bucket.scale = scale;
        bucket.scaleAt = at;
      }
    }
    for (const task of records) {
      if (classList && task.classId !== context.classId) continue;
      const bucket = ensureTerm(task.classId, task.termId, task.termId
        ? (task.termId === term.id ? term.label : `Term ${task.termId}`) : 'Unidentified term');
      const observed = touch(bucket);
      observed.ids.add(task.id);
      const prior = bucket.records[task.id];
      if (at < Math.max(prior?.observedAt ?? 0, bucket.lastComplete ?? 0)) continue;
      const eligible = app.validScore(task);
      const priorGrade = prior && app.validScore(prior);
      if (!classList && !detail && prior?.classList && priorGrade) continue;
      const gradeChanged = priorGrade && (!eligible || task.earnedPoints !== prior.earnedPoints ||
        task.maxPoints !== prior.maxPoints || (task.category && prior.category && app.key(task.category) !== app.key(prior.category)) ||
        Boolean(task.excluded) !== Boolean(prior.excluded));
      const confirmedPoints = classList && rendered && eligible && !task.issue && !snapshot.loading;
      const trusted = task.termId === term.id && (confirmedPoints || authoritative || verifiedEdit ||
        (detail && task.classId === context.classId && task.id === context.taskId));
      if (gradeChanged && (!trusted || (!eligible && !task.explicitlyUngraded))) {
        observed.preserved = true;
        continue;
      }
      if (!classList && !prior && bucket.complete) bucket.complete = false;
      if (classList || detail || !bucket.lastScan) observed.read = true;
      bucket.records[task.id] = { ...task, category: task.category || prior?.category || '',
        taskUrl: task.taskUrl ?? prior?.taskUrl ?? null, due: task.due ?? prior?.due,
        possiblePoints: task.possiblePoints ?? prior?.possiblePoints, completed: task.completed ?? prior?.completed,
        observedAt: at, classList: classList || detail, fromDetail: Boolean(detail), source };
    }
    for (const [bucket, observed] of visited) {
      if (at < (bucket.lastScan ?? 0)) continue;
      const complete = authoritative && bucket.termId === term.id;
      if (complete) {
        bucket.lastComplete = at;
        for (const [id, task] of Object.entries(bucket.records)) {
          if (!observed.ids.has(id) && task.observedAt <= at) delete bucket.records[id];
        }
      }
      if (observed.preserved) {
        bucket.complete = false;
        bucket.lastError = 'The latest read did not verify a changed score. Previously verified points were kept.';
        bucket.lastErrorAt = at;
      } else if (classList) {
        if (!incremental) bucket.complete = complete;
        if (at >= (bucket.lastErrorAt ?? 0)) {
          bucket.lastError = null;
          bucket.lastErrorAt = at;
        }
      }
      bucket.dataRevision = (bucket.dataRevision ?? 0) + 1;
      bucket.gradedCount = Object.values(bucket.records).filter((task) => app.validScore(task) && !task.excluded).length;
      if (observed.read && !observed.preserved) {
        bucket.lastScan = at;
        bucket.lastSource = source;
        if (bucket.termId) cache.lastSync = Math.max(cache.lastSync ?? 0, at);
      }
    }
    return cache;
  }

  function mergeCheck(cache, check) {
    const checks = cache.sourceChecks ??= {};
    const previous = checks[check.source];
    if ((previous?.at ?? 0) > check.at) return;
    checks[check.source] = { ...check, renderedAt: check.renderedAt ?? previous?.renderedAt };
    if (check.detail && !check.error) return;
    const subject = cache.classes[check.classId];
    if (!subject) return;
    const key = check.termId ? termKey(check.termId) : classTermKey(subject);
    const target = subject.terms[key] ?? subject;
    if (check.at < Math.max(target.lastErrorAt ?? 0, target.lastScan ?? 0)) return;
    if (check.error || (target.lastErrorAt ?? 0) < check.at) {
      target.lastError = check.error ?? null;
      target.lastErrorAt = check.at;
    }
    if (check.unchanged && target !== subject && target.lastScan && check.termId && !target.lastError) {
      target.lastScan = check.at;
      if (check.complete && target.complete) target.lastComplete = check.at;
      cache.lastSync = Math.max(cache.lastSync ?? 0, check.at);
    }
  }

  function deadline(due) {
    if (typeof due === 'number') return due;
    if (typeof due !== 'string') return NaN;
    // A date-only deadline is upcoming until the next local calendar day.
    const day = new Date(due + 'T00:00:00');
    return day.setDate(day.getDate() + 1);
  }

  function upcomingTasks(cache, selection, now = Date.now()) {
    const upcoming = [];
    for (const [classId, subject] of Object.entries(cache.classes)) {
      const key = selection === currentTerms ? classTermKey(subject) : selection;
      const records = subject.terms[key]?.records ?? {};
      const elsewhere = new Set(Object.entries(subject.terms).filter(([term]) => term !== key && term !== 'unknown')
        .flatMap(([, bucket]) => Object.keys(bucket.records)));
      const unknown = selection === currentTerms && key !== 'unknown' ? subject.terms.unknown?.records ?? {} : {};
      for (const id of new Set([...Object.keys(records), ...Object.keys(unknown)])) {
        const known = records[id];
        const extra = unknown[id];
        if ((!known && elsewhere.has(id)) || [known, extra].some((task) =>
          task && (task.completed || app.validScore(task) || task.gradeKind === 'letter'))) continue;
        const task = known ?? extra;
        const due = known?.due ?? extra?.due;
        const expiresAt = deadline(due);
        if (!(expiresAt > now)) continue;
        upcoming.push({ ...task, classId, due, expiresAt, termKey: key, subject: subject.name || task.subject || 'Class ' + classId,
          category: known?.category || extra?.category, possiblePoints: known?.possiblePoints ?? extra?.possiblePoints,
          taskUrl: known?.taskUrl ?? extra?.taskUrl });
      }
    }
    return upcoming.sort((a, b) => a.expiresAt - b.expiresAt || a.title.localeCompare(b.title));
  }

  Object.assign(app, { settingsDefaults, freshCache, mergeScan, mergeCheck, currentTerms, classTermKey, upcomingTasks });
})();
