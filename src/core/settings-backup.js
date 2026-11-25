(() => {
  const app = globalThis.MBGC;
  const backupFormat = 'gradelens-settings';
  const backupVersion = 2;
  const classId = (value) => typeof value === 'string' && /^\d{1,30}$/.test(value);
  const termId = (value) => typeof value === 'string' && /^[\w.-]{1,80}$/.test(value) && !/^(?:all|unknown|0|-1|default)$/i.test(value);
  const record = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const text = (value, length) => typeof value === 'string' && value.trim().length > 0 && value.length <= length;
  const unique = (values) => new Set(values).size === values.length;
  const pair = (item) => item.classId + ':' + item.termId;
  const conflict = (field) => { throw new Error('Invalid ' + field + ' in the settings backup.'); };
  const check = (condition, field) => { if (!condition) conflict(field); };
  const enums = { appearance: ['system', 'light', 'dark'], density: ['comfortable', 'compact'], motion: ['full', 'reduced', 'off'] };
  const method = (value) => typeof value === 'string' && Object.hasOwn(app.methods, value);

  function preferences(input) {
    check(record(input), 'preferences');
    const entries = [];
    for (const [key, defaultValue] of Object.entries(app.settingsDefaults)) {
      if (!Object.hasOwn(input, key)) continue;
      const value = input[key];
      if (key === 'subjectMethods') {
        check(record(value) && Object.entries(value).every(([id, item]) => classId(id) && method(item)), 'subject methods');
        entries.push([key, Object.fromEntries(Object.entries(value))]);
        continue;
      }
      const valid = key === 'method' ? method(value) : key === 'academicTerm' ? app.termPreferenceValid(value) :
        Object.hasOwn(enums, key) ? enums[key].includes(value) :
          typeof defaultValue === 'boolean' ? typeof value === 'boolean' :
            key === 'refreshMinutes' && Number.isFinite(value) && value >= 0 && value <= 120;
      check(valid, key);
      entries.push([key, value]);
    }
    return Object.fromEntries(entries);
  }

  function categoryWeights(input, field) {
    check(record(input), field);
    const entries = Object.entries(input);
    check(entries.every(([name, value]) => text(name, 180) && app.validWeight(value)) &&
      unique(entries.map(([name]) => app.key(name))), field);
    return Object.fromEntries(entries);
  }

  function prediction(input) {
    check(record(input) && classId(input.classId) && termId(input.termId) && Array.isArray(input.entries), 'estimator prediction');
    check(input.entries.length <= 2000 && unique(input.entries.map((item) => item?.id)), 'estimator prediction IDs');
    const entries = input.entries.map((item) => {
      check(record(item) && /^scenario:(?:\d{1,15}|[a-f0-9-]{36})$/.test(item.id) && typeof item.id === 'string' &&
        (item.replaces === '' || (typeof item.replaces === 'string' && /^[\w.-]{1,80}$/.test(item.replaces))) &&
        text(item.title, 500) && text(item.category, 180) && app.validScore(item) && item.maxPoints <= 1000000, 'estimator scores');
      return { id: item.id, replaces: item.replaces, title: item.title, category: item.category,
        earnedPoints: item.earnedPoints, maxPoints: item.maxPoints, scenario: true };
    });
    return { classId: input.classId, termId: input.termId, entries,
      overrides: categoryWeights(input.overrides ?? {}, 'estimator category overrides') };
  }

  function studentSettings(input) {
    if (input === null) return null;
    check(record(input), 'student settings');
    const student = {};
    if (Object.hasOwn(input, 'weights')) {
      check(record(input.weights) && Object.keys(input.weights).every(classId), 'class weight overrides');
      student.weights = Object.fromEntries(Object.entries(input.weights).map(([id, value]) => [id, categoryWeights(value, 'class category weights')]));
    }
    if (Object.hasOwn(input, 'scale')) {
      const scale = input.scale === null ? null : app.normalizeScale(input.scale);
      check(input.scale === null || (scale && scale.every((row) => row.length === 2 && text(row[1], 40))), 'letter boundaries');
      student.scale = scale;
    }
    if (Object.hasOwn(input, 'predictions')) {
      check(Array.isArray(input.predictions), 'saved predictions');
      student.predictions = input.predictions.map(prediction);
      check(unique(student.predictions.map(pair)), 'saved prediction scopes');
    }
    if (Object.hasOwn(input, 'goalPlans')) {
      check(Array.isArray(input.goalPlans) && input.goalPlans.length <= 100, 'saved goal plans');
      student.goalPlans = input.goalPlans.map((entry) => {
        try {
          const plan = app.normalizedGoalPlan(entry);
          check(Number.isSafeInteger(entry.revision ?? 1) && (entry.revision ?? 1) >= 1 && (entry.revision ?? 1) < Number.MAX_SAFE_INTEGER &&
            Number.isSafeInteger(entry.updatedAt ?? 0) && (entry.updatedAt ?? 0) >= 0 &&
            (entry.updatedAt ?? 0) <= 8640000000000000, 'saved goal plan metadata');
          return { ...plan, revision: entry.revision ?? 1, updatedAt: entry.updatedAt ?? 0 };
        } catch { return conflict('saved goal plan'); }
      });
      check(unique(student.goalPlans.map((plan) => plan.id)), 'saved goal plan IDs');
    }
    return student;
  }

  function scopeFromCache(cache) {
    return Object.fromEntries(Object.entries(cache?.classes ?? {}).filter(([id]) => classId(id)).map(([id, subject]) =>
      [id, [...new Set(Object.values(subject.terms ?? {}).map((bucket) => bucket.termId).filter(termId))].sort()]));
  }

  function typedScope(input) {
    check(record(input) && Object.entries(input).every(([id, terms]) => classId(id) &&
      Array.isArray(terms) && terms.every(termId) && unique(terms)), 'class and term scope');
    return input;
  }

  function withStoredScopes(scope, prefs, student) {
    const entries = new Map(Object.entries(scope).map(([id, terms]) => [id, new Set(terms)]));
    const ensure = (id) => {
      if (!entries.has(id)) entries.set(id, new Set());
      return entries.get(id);
    };
    for (const id of [...Object.keys(prefs.subjectMethods ?? {}), ...Object.keys(student?.weights ?? {})]) ensure(id);
    for (const item of [...(student?.predictions ?? []), ...(student?.goalPlans ?? [])]) ensure(item.classId).add(item.termId);
    return Object.fromEntries([...entries].map(([id, terms]) => [id, [...terms].sort()]));
  }

  function readBackup(input) {
    if (!record(input) || input.format !== backupFormat) throw new Error('Choose a GradeLens settings backup. A grade export cannot be restored.');
    if (![1, backupVersion].includes(input.version)) throw new Error('This settings backup version is unsupported.');
    check(typeof input.school === 'string' && /^[a-z0-9-]+\.managebac\.com$/i.test(input.school), 'school');
    check(typeof input.exportedAt === 'string' && Number.isFinite(Date.parse(input.exportedAt)), 'backup timestamp');
    const prefs = preferences(input.version === 1 ? input.preferences ?? input.settings : input.preferences);
    const student = studentSettings(input.version === 1 ? input.student ?? null : input.student);
    const scope = input.version === 1 ? withStoredScopes(typedScope(input.scope ?? {}), prefs, student) :
      withStoredScopes(typedScope(input.scope), prefs, student);
    return { format: backupFormat, version: backupVersion, exportedAt: input.exportedAt,
      school: input.school.toLowerCase(), preferences: prefs, scope, student,
      ...(Object.hasOwn(input, 'history') ? { history: app.readHistoryArchive(input.history) } : {}) };
  }

  function makeBackup({ school, settings, scope, student, exportedAt = new Date().toISOString() }) {
    const prefs = preferences(app.normalizeSettings(settings));
    return readBackup({ format: backupFormat, version: backupVersion, exportedAt, school, preferences: prefs, scope, student });
  }

  function prepareRestore(backup, { school, scope, settings, student }) {
    const source = readBackup(backup);
    const sameSchool = source.school === school;
    const classes = sameSchool ? Object.keys(source.scope).filter((id) => Object.hasOwn(scope, id)) : [];
    const matches = (id) => classes.includes(id);
    const termMatches = ({ classId: id, termId: term }) => matches(id) && scope[id].includes(term);
    const matchingScopes = new Set(classes.flatMap((id) => source.scope[id].filter((term) => scope[id].includes(term))
      .map((term) => pair({ classId: id, termId: term }))));
    const current = app.normalizeSettings(settings);
    const { subjectMethods, academicTerm, ...global } = source.preferences;
    const termAvailable = academicTerm === 'current' || (sameSchool && typeof academicTerm === 'string' &&
      Object.values(scope).some((terms) => terms.includes(academicTerm.slice(5))));
    const nextSettings = { ...current, ...global };
    if (termAvailable) nextSettings.academicTerm = academicTerm;
    function replaceClasses(existing, imported) {
      const kept = Object.entries(existing ?? {}).filter(([id]) => !matches(id));
      const replaced = Object.entries(imported).filter(([id]) => matches(id));
      return Object.fromEntries([...kept, ...replaced]);
    }
    const methodCount = Object.keys(subjectMethods ?? {}).filter(matches).length;
    if (subjectMethods) nextSettings.subjectMethods = replaceClasses(current.subjectMethods, subjectMethods);
    const nextStudent = {};
    const previous = student ?? {};
    const imported = (sameSchool && student && source.student) || null;
    if (imported) {
      if (Object.hasOwn(imported, 'scale')) nextStudent.scale = imported.scale;
      if (imported.weights && classes.length) nextStudent.weights = replaceClasses(previous.weights, imported.weights);
      const keep = (list) => (list ?? []).filter((item) => !matchingScopes.has(pair(item)));
      if (imported.predictions && matchingScopes.size) {
        nextStudent.predictions = [...keep(previous.predictions), ...imported.predictions.filter(termMatches)];
      }
      if (imported.goalPlans && matchingScopes.size) {
        const old = new Map((previous.goalPlans ?? []).map((plan) => [plan.id, plan]));
        const plans = imported.goalPlans.filter(termMatches).map((plan) => ({
          ...plan, revision: Math.max(plan.revision, old.get(plan.id)?.revision ?? 0) + 1
        }));
        nextStudent.goalPlans = [...keep(previous.goalPlans), ...plans];
        if (!unique(nextStudent.goalPlans.map((plan) => plan.id)) || nextStudent.goalPlans.length > 100) {
          throw new Error('This backup conflicts with saved plans outside the matching subjects or exceeds the saved plan limit.');
        }
      }
    }
    return {
      settings: nextSettings, student: nextStudent,
      preview: {
        exportedAt: source.exportedAt, school: source.school, settings: global,
        term: termAvailable ? academicTerm : null, termSkipped: Boolean(academicTerm && !termAvailable),
        matchingClasses: classes.length, matchingTerms: matchingScopes.size,
        replaceMethods: Boolean(subjectMethods && classes.length), methodCount,
        weightCount: imported?.weights ? Object.keys(imported.weights).filter(matches).length : 0,
        goalCount: imported?.goalPlans?.filter(termMatches).length ?? 0,
        predictionCount: imported?.predictions?.filter(termMatches).reduce((n, bucket) => n + bucket.entries.length, 0) ?? 0,
        sections: Object.keys(nextStudent),
        skippedClasses: Object.keys(source.scope).length - classes.length,
        skippedTerms: Object.values(source.scope).reduce((total, terms) => total + terms.length, 0) - matchingScopes.size,
        studentSkipped: Boolean(source.student && !imported)
      }
    };
  }

  Object.assign(app, { readBackup, makeBackup, prepareRestore, scopeFromCache, prediction, predictionScope: pair });
})();
