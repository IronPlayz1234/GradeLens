(() => {
  const app = globalThis.MBGC ??= {};
  const methods = {
    percentage: { label: 'Percentage Weights', explanation: 'Averages task percentages within each category, then applies category weights.' },
    points: { label: 'Percentage Weights with Points-Based Averaging', explanation: 'Pools earned and possible points within each category, then applies category weights.' },
    absolute: { label: 'Absolute Weights', explanation: 'Applies the category weight to each graded task individually.' }
  };
  const defaultScale = [[90, 'A*'], [80, 'A'], [70, 'B'], [60, 'C'], [50, 'D'], [40, 'E'], [0, 'U']];
  const key = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const validScore = ({ earnedPoints, maxPoints }) => Number.isFinite(earnedPoints) &&
    Number.isFinite(maxPoints) && maxPoints > 0 && earnedPoints >= 0 && earnedPoints <= maxPoints;
  const validWeight = (value) => Number.isFinite(value) && value >= 0 && value <= 100;
  const normalizeScale = (rows) => {
    if (!Array.isArray(rows) || !rows.length || rows.some((row) => !Array.isArray(row) ||
      !validWeight(row[0]) || typeof row[1] !== 'string' || !row[1].trim())) return null;
    if (new Set(rows.map(([min]) => min)).size !== rows.length ||
      new Set(rows.map(([, label]) => label.toUpperCase())).size !== rows.length ||
      !rows.some(([min]) => min === 0)) return null;
    return [...rows].sort(([a], [b]) => b - a);
  };
  const letter = (value, scale = defaultScale) => Number.isFinite(value)
    ? scale.find(([min]) => value >= min)?.[1] ?? null
    : null;

  function calculate(tasks, weights, method = 'percentage', overrides = {}) {
    const categories = new Map();
    for (const [name, weight] of Object.entries(weights ?? {})) {
      categories.set(key(name), { name, weight, tasks: [] });
    }
    for (const task of tasks) {
      const category = key(task.category);
      if (!categories.has(category)) categories.set(category, { name: task.category || 'Uncategorized', tasks: [] });
      categories.get(category).tasks.push(task);
    }

    let numerator = 0;
    let denominator = 0;
    let count = 0;
    let weightedCount = 0;
    const missing = [];
    const breakdown = [];
    for (const [id, category] of categories) {
      const graded = category.tasks.filter((task) => validScore(task) && !task.excluded);
      const override = Object.hasOwn(overrides, id) ? overrides[id] : null;
      const simulated = validWeight(override);
      const taskCount = simulated ? Math.max(1, graded.length) : graded.length;
      let average = null;
      if (simulated) {
        average = override;
      } else if (graded.length) {
        average = method === 'points'
          ? 100 * (graded.reduce((sum, task) => sum + task.earnedPoints, 0) /
            graded.reduce((sum, task) => sum + task.maxPoints, 0))
          : graded.reduce((sum, task) => sum + 100 * task.earnedPoints / task.maxPoints, 0) / graded.length;
      }
      count += graded.length;
      if (taskCount && !validWeight(category.weight)) missing.push(category.name);
      if (taskCount && validWeight(category.weight) && category.weight > 0) {
        const weight = category.weight * (method === 'absolute' ? taskCount : 1);
        numerator += weight * average;
        denominator += weight;
        weightedCount += graded.length;
      }
      breakdown.push({ ...category, average, simulated, gradedCount: graded.length, taskCount });
    }
    return {
      percentage: denominator && !missing.length ? numerator / denominator : null,
      count, weightedCount, missing, breakdown,
      ungraded: tasks.filter((task) => !validScore(task)).length,
      excluded: tasks.filter((task) => task.excluded && validScore(task)).length,
      flagged: tasks.filter((task) => task.issue).length
    };
  }

  function withHypotheticals(tasks, scenarios) {
    const replacements = new Set(scenarios.map((scenario) => scenario.replaces).filter(Boolean));
    return [...tasks.filter((task) => !replacements.has(task.id)), ...scenarios];
  }

  function targetScore({ tasks, weights, overrides = {}, method, future, target }) {
    const category = key(future.category);
    const weight = Object.entries(weights ?? {}).find(([name]) => key(name) === category)?.[1];
    if (!validWeight(target) || !validWeight(weight) || weight === 0 ||
      Object.hasOwn(overrides, category) || !validScore({ ...future, earnedPoints: 0 })) {
      return { state: 'unavailable' };
    }
    const predict = (earnedPoints) => calculate(
      withHypotheticals(tasks, [{ ...future, earnedPoints }]), weights, method, overrides
    ).percentage;
    const low = predict(0);
    const high = predict(future.maxPoints);
    if (low === null || high === null || !Number.isFinite(high)) return { state: 'unavailable' };
    if (target <= low) return { state: 'achieved', required: 0, predicted: low };
    if (target > high || high <= low) return { state: 'impossible', predicted: high };
    const required = Math.min(future.maxPoints, future.maxPoints * (target - low) / (high - low));
    return { state: 'achievable', required, predicted: predict(required) };
  }

  Object.assign(app, { methods, defaultScale, key, validScore, validWeight, normalizeScale, letter,
    calculate, withHypotheticals, targetScore });
})();
