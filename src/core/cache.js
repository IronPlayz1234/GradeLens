(() => {
  const app = globalThis.MBGC;
  const settingsDefaults = { method: 'percentage', refreshMinutes: 5 };
  const freshCache = () => ({ classes: {}, sources: [], lastSync: null });

  function mergeScan(cache, snapshot) {
    const { records, classes, context, term, weights, scale, complete, readable, at } = snapshot;
    cache.sources = [...new Set([...cache.sources, ...snapshot.sources])].slice(-100);
    for (const [classId, name] of Object.entries(classes)) {
      cache.classes[classId] ??= { name: '', terms: {} };
      if (name) cache.classes[classId].name = name;
    }
    const terms = new Map();
    const ensureTerm = (classId, termId, label) => {
      const subject = cache.classes[classId] ??= { name: '', terms: {} };
      const bucket = subject.terms[termId ? 'term:' + termId : 'unknown'] ??= {
        label, termId, records: {}, weights: {}, scale: null, lastScan: null, complete: false, weightScan: 0
      };
      if (label && (bucket.label.startsWith('Term ') || !bucket.label)) bucket.label = label;
      return bucket;
    };
    if (context.classId && ['tasks', 'overview', 'task'].includes(context.type)) {
      const bucket = ensureTerm(context.classId, term.id, term.label);
      if (context.type === 'tasks' && readable) {
        terms.set(bucket, new Set());
        const subject = cache.classes[context.classId];
        const field = snapshot.visible ? 'selectedTerm' : snapshot.defaultTerm ? 'defaultTerm' : null;
        if (field && term.id && at >= (subject[field]?.at ?? 0)) subject[field] = { id: term.id, at };
      }
      if (context.type === 'tasks' && at >= bucket.weightScan && (Object.keys(weights).length || complete)) {
        bucket.weights = weights;
        bucket.weightScan = at;
      }
      if (scale && (!bucket.scaleAt || at >= bucket.scaleAt)) {
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
      if (prior && !complete && app.validScore(prior) && !app.validScore(task)) {
        bucket.records[task.id] = { ...prior, issue: task.issue || 'Latest scan did not expose this cached score' };
        continue;
      }
      bucket.records[task.id] = { ...task, observedAt: at };
    }
    for (const [bucket, seen] of terms) {
      if (at < (bucket.lastScan ?? 0)) continue;
      const authoritative = complete && bucket.termId === term.id && context.type === 'tasks';
      if (authoritative) {
        bucket.lastComplete = at;
        for (const [id, task] of Object.entries(bucket.records)) {
          if (!seen.has(id) && task.observedAt <= at) delete bucket.records[id];
        }
      }
      bucket.lastScan = at;
      bucket.complete = authoritative;
    }
    if (readable) cache.lastSync = Math.max(cache.lastSync ?? 0, at);
    return cache;
  }

  Object.assign(app, { settingsDefaults, freshCache, mergeScan });
})();
