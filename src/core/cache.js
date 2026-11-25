(() => {
  const app = globalThis.MBGC;
  const settingsDefaults = { method: 'percentage', refreshMinutes: 5 };
  const freshCache = () => ({ classes: {}, sources: [], sourceChecks: {}, lastSync: null, revision: 0 });
  const currentTerms = 'current';

  function classTermKey(subject, nativeTerm = null) {
    if (nativeTerm) return 'term:' + nativeTerm;
    const preferred = subject?.selectedTerm ?? subject?.defaultTerm;
    if (preferred) return 'term:' + preferred.id;
    const available = Object.entries(subject?.terms ?? {}).filter(([, bucket]) => bucket.termId && bucket.lastScan);
    return available.length === 1 ? available[0][0] : 'unknown';
  }

  function mergeScan(cache, snapshot) {
    const { records, classes, context, term, weights, scale, at, incremental } = snapshot;
    const previousTerm = cache.classes[context.classId]?.terms[term.id ? 'term:' + term.id : 'unknown'];
    const complete = snapshot.complete &&
      (snapshot.visible || records.length > 0 || !Object.keys(previousTerm?.records ?? {}).length);
    if (snapshot.sources.length) cache.sources = [...new Set([...cache.sources, ...snapshot.sources])].slice(-300);
    const ensureClass = (classId) => cache.classes[classId] ??= { name: '', terms: {} };
    for (const [classId, name] of Object.entries(classes)) {
      const subject = ensureClass(classId);
      if (name) subject.name = name;
    }
    const terms = new Map();
    const incompleteScores = new Set();
    const ensureTerm = (classId, termId, label) => {
      const subject = ensureClass(classId);
      const bucket = subject.terms[termId ? 'term:' + termId : 'unknown'] ??= {
        label, termId, records: {}, weights: {}, scale: null, lastScan: null, complete: false, weightScan: 0
      };
      if (label && (!bucket.label || bucket.label.startsWith('Term ') || bucket.label === 'Selected academic term')) bucket.label = label;
      return bucket;
    };
    const classList = context.type === 'tasks';
    if (context.classId && !incremental) {
      const bucket = ensureTerm(context.classId, term.id, term.label);
      if (classList) {
        const hasList = complete || records.some((task) => task.termId === term.id);
        if (hasList) terms.set(bucket, new Set());
        const subject = ensureClass(context.classId);
        const field = snapshot.visible ? 'selectedTerm' :
          snapshot.defaultTerm && (hasList || classTermKey(subject) === 'unknown') ? 'defaultTerm' : null;
        if (field && term.id && (subject[field]?.id !== term.id || !subject[field]) &&
          at >= (subject[field]?.at ?? 0)) subject[field] = { id: term.id, at };
        if (Object.keys(weights).length && at >= bucket.weightScan &&
          (at - bucket.weightScan >= 30000 || Object.entries(weights).some(([key, value]) => bucket.weights[key] !== value))) {
          bucket.weights = { ...bucket.weights, ...weights };
          bucket.weightScan = at;
        }
      }
      if (scale && at >= (bucket.scaleAt ?? 0)) {
        bucket.scale = scale;
        bucket.scaleAt = at;
      }
    }
    for (const task of records) {
      const bucket = ensureTerm(task.classId, task.termId, task.termId
        ? (task.termId === term.id ? term.label : `Term ${task.termId}`) : 'Unidentified term');
      if (!terms.has(bucket)) terms.set(bucket, new Set());
      terms.get(bucket).add(task.id);
      const prior = bucket.records[task.id];
      if (prior?.observedAt > at || (!prior && (bucket.lastComplete ?? 0) > at)) continue;
      const graded = app.validScore(task);
      const previouslyGraded = prior && app.validScore(prior);
      const confirmedUngraded = classList && (snapshot.visible ? complete || task.explicitlyUngraded :
        complete && task.explicitlyUngraded);
      if (previouslyGraded && !graded && !confirmedUngraded) {
        if (classList) {
          bucket.records[task.id] = { ...prior, issue: task.issue || 'Latest scan did not expose this cached score' };
          incompleteScores.add(bucket);
        }
        continue;
      }
      if (!classList && prior?.classList && previouslyGraded) continue;
      if (!classList && !prior && bucket.complete) bucket.complete = false;
      const normalized = { ...task, category: task.category || prior?.category || '', classList };
      const changed = !prior || Object.keys(normalized).some((key) => normalized[key] !== prior[key]);
      if (changed || at - prior.observedAt >= 30000) bucket.records[task.id] = { ...normalized, observedAt: at };
    }
    for (const [bucket, seen] of terms) {
      if (at < (bucket.lastScan ?? 0)) continue;
      const authoritative = complete && bucket.termId === term.id && classList && !incremental;
      let removed = false;
      if (authoritative) {
        if (!bucket.lastComplete || at - bucket.lastComplete >= 30000) bucket.lastComplete = at;
        for (const [id, task] of Object.entries(bucket.records)) {
          if (!seen.has(id) && task.observedAt <= at) {
            delete bucket.records[id];
            removed = true;
          }
        }
      }
      if (removed) bucket.lastComplete = at;
      if (classList) {
        if (incompleteScores.has(bucket)) bucket.complete = false;
        else if (!incremental) bucket.complete = authoritative;
        if (at >= (bucket.lastErrorAt ?? 0)) bucket.lastError = null;
      }
      // A cross-class overview can supply grades before any class scan, but cannot renew an older class list.
      if (!bucket.lastScan || (classList && (incremental || removed || at - bucket.lastScan >= 30000 ||
        [...seen].some((id) => bucket.records[id]?.observedAt === at)))) bucket.lastScan = at;
      if (bucket.termId) cache.lastSync = Math.max(cache.lastSync ?? 0, bucket.lastScan);
    }
    return cache;
  }

  function mergeCheck(cache, check) {
    const checks = cache.sourceChecks ??= {};
    const previous = checks[check.source];
    if ((previous?.at ?? 0) > check.at) return;
    checks[check.source] = check;
    const subject = cache.classes[check.classId];
    if (!subject) return;
    const key = check.termId ? 'term:' + check.termId : classTermKey(subject);
    const target = subject.terms[key] ?? subject;
    if (check.at < Math.max(target.lastErrorAt ?? 0, target.lastScan ?? 0)) return;
    target.lastError = check.error ?? null;
    target.lastErrorAt = check.at;
    if (check.unchanged && target !== subject && target.lastScan && check.termId) {
      target.lastScan = check.at;
      cache.lastSync = Math.max(cache.lastSync ?? 0, check.at);
    }
  }

  Object.assign(app, { settingsDefaults, freshCache, mergeScan, mergeCheck, currentTerms, classTermKey });
})();
