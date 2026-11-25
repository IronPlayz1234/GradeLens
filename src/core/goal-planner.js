(() => {
  const app = globalThis.MBGC;
  const planTaskLimit = 50;
  const planPointLimit = 1000000;
  const decimalPlaces = { whole: 1, decimal: 100 };
  const ticksFor = (value, units) => {
    const ticks = Math.round(value * units);
    return Math.abs(ticks / units - value) <= Number.EPSILON * Math.max(1, value) * 4 ? ticks : null;
  };

  function validPlanTask(row) {
    const units = decimalPlaces[row?.precision];
    return Object.hasOwn(decimalPlaces, row?.precision) &&
      typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 80 &&
      typeof row.category === 'string' && row.category.trim().length > 0 && row.category.length <= 180 &&
      Number.isFinite(row.maxPoints) && row.maxPoints > 0 && row.maxPoints <= planPointLimit &&
      ticksFor(row.maxPoints, units) > 0 && (row.fixed === null ||
        (app.validScore({ earnedPoints: row.fixed, maxPoints: row.maxPoints }) && ticksFor(row.fixed, units) !== null));
  }

  function solveGoalPlan({ tasks, weights, method, future, target }) {
    const current = app.calculate(tasks, weights, method);
    const unavailable = (reason) => ({ state: 'unavailable', reason, current, target });
    if (!app.validWeight(target)) return unavailable('Enter a target from 0 to 100%.');
    if (!Array.isArray(future) || !future.length) return unavailable('Add at least one planned assessment.');
    if (future.length > planTaskLimit || future.some((row) => !validPlanTask(row))) {
      return unavailable('Check each assessment’s category, possible points, fixed score, and mark precision.');
    }
    if (new Set(future.map((row) => row.id)).size !== future.length) return unavailable('Planned assessment IDs must be unique.');
    const categories = new Map(Object.entries(weights ?? {}).map(([name, value]) => [app.key(name), value]));
    if (future.some(({ category }) => !app.validWeight(categories.get(app.key(category))))) {
      return unavailable('Choose a category with a known weight for every assessment.');
    }
    // Keep only valid real grades in the calculation. Future scores are appended
    // as separate records and never replace a real assessment.
    const base = tasks.filter((task) => app.validScore(task) && !task.excluded);
    const modeled = (scores) => app.calculate(base.concat(future.map((row, index) => ({
      id: row.id, category: row.category, earnedPoints: scores[index], maxPoints: row.maxPoints
    }))), weights, method);
    const scoresAt = (ratio) => future.map((row) => row.fixed ?? ratio * row.maxPoints);
    const minimum = modeled(scoresAt(0));
    const maximum = modeled(scoresAt(1));
    if (!Number.isFinite(maximum.percentage) || !Number.isFinite(minimum.percentage)) {
      const missing = maximum.missing;
      return unavailable(missing.length ? 'Category weights are needed for ' + missing.join(', ') + '.' :
        'The real and planned assessments need at least one positive category weight.');
    }
    const meets = (value) => value >= target || target - value <= Number.EPSILON * Math.max(1, target) * 8;
    const onBoundary = (value) => value < target && meets(value) ? target : value;
    const unknown = future.some((row) => row.fixed === null && categories.get(app.key(row.category)) > 0);
    const currentMeets = Number.isFinite(current.percentage) && meets(current.percentage);
    const state = !meets(maximum.percentage) ? 'impossible' :
      currentMeets || meets(minimum.percentage) ? 'achieved' : 'achievable';
    const ratio = state === 'impossible' || !unknown ? null : meets(minimum.percentage) ? 0 :
      Math.min(1, (target - minimum.percentage) / (maximum.percentage - minimum.percentage));

    function roundedScores(common) {
      return future.map((row) => {
        if (row.fixed !== null) return row.fixed;
        if (!categories.get(app.key(row.category))) return 0;
        const units = decimalPlaces[row.precision];
        const raw = common * row.maxPoints;
        return Math.min(row.maxPoints, (ticksFor(raw, units) ?? Math.ceil(raw * units)) / units);
      });
    }

    let scores = state === 'impossible' ? scoresAt(1) : roundedScores(ratio ?? 0);
    let projection = modeled(scores);
    // Verify the discrete score combination with the same engine. At an exact
    // mark boundary, rounding noise must never produce an under-target plan.
    if (state !== 'impossible' && !meets(projection.percentage)) {
      let low = ratio ?? 0, high = 1;
      for (let i = 0; i < 53; i++) {
        const middle = (low + high) / 2;
        if (meets(modeled(roundedScores(middle)).percentage)) high = middle;
        else low = middle;
      }
      scores = roundedScores(high);
      projection = modeled(scores);
    }
    const reaches = meets(projection.percentage);
    return { state, current, currentMeets, target, method, minimum: minimum.percentage, maximum: onBoundary(maximum.percentage),
      common: ratio === null ? null : ratio * 100, predicted: onBoundary(projection.percentage),
      reaches, base, breakdown: projection.breakdown,
      scores: future.map((row, index) => ({ ...row, earnedPoints: scores[index],
        weight: categories.get(app.key(row.category)) })) };
  }

  function goalDataVersion({ tasks, weights, method, scale }) {
    const records = tasks.filter((task) => app.validScore(task) && !task.excluded)
      .map((task) => JSON.stringify([task.id, app.key(task.category), task.earnedPoints, task.maxPoints])).sort();
    const categories = Object.entries(weights).map(([name, weight]) => [app.key(name), weight]).sort();
    const text = JSON.stringify([records, categories, method, scale]);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function normalizedGoalPlan(plan) {
    if (!plan || typeof plan.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(plan.id) ||
      typeof plan.classId !== 'string' || !/^\d{1,30}$/.test(plan.classId) ||
      typeof plan.termId !== 'string' || !/^[\w.-]{1,80}$/.test(plan.termId) ||
      typeof plan.name !== 'string' || !plan.name.trim() || plan.name.length > 100 ||
      typeof plan.source !== 'string' || !/^[0-9a-f]{8}$/.test(plan.source) || !['percentage', 'letter'].includes(plan.targetType) ||
      (plan.targetType === 'letter' ? typeof plan.target !== 'string' || !plan.target.trim() || plan.target.length > 40 :
        !app.validWeight(plan.target)) ||
      !Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > planTaskLimit ||
      plan.tasks.some((row) => !validPlanTask(row)) || new Set(plan.tasks.map((row) => row.id)).size !== plan.tasks.length) {
      throw new Error('Check the plan name, target, and assessment inputs.');
    }
    return { id: plan.id, classId: plan.classId, termId: plan.termId, name: plan.name.trim(),
      targetType: plan.targetType, target: plan.target, source: plan.source,
      tasks: plan.tasks.map(({ id, category, maxPoints, precision, fixed }) => ({ id, category, maxPoints, precision, fixed })) };
  }

  Object.assign(app, { solveGoalPlan, normalizedGoalPlan, goalDataVersion, planTaskLimit, planPointLimit });
})();
