(() => {
  const app = globalThis.MBGC;
  const estimateNotice = 'Calculated estimates. Teacher-hidden assessments or different grading settings can affect official grades.';
  const gradeOverrides = { weights: {}, scale: null };
  const text = (value) => typeof value === 'string' ? value : null;

  function gradeInputs(cache, settings, overrides, classId, termKey) {
    const subject = cache.classes[classId];
    const bucket = subject?.terms[termKey];
    const manual = overrides?.weights?.[classId];
    return {
      classId, subject, termKey, bucket, verified: Boolean(bucket?.termId),
      title: subject?.name || 'Class ' + classId, label: bucket?.label || 'Unidentified term',
      weights: manual ?? bucket?.weights ?? {}, customWeights: Boolean(manual),
      method: app.methodFor(settings, classId), scale: overrides?.scale ?? bucket?.scale ?? app.defaultScale,
      scaleLabel: overrides?.scale ? 'Custom letter scale' : bucket?.scale ? 'Displayed task letter scale' : 'Default task letter scale',
      tasks: Object.values(bucket?.records ?? {}), error: bucket?.lastErrorAt ? bucket.lastError : subject?.lastError
    };
  }

  function estimate(data, method) {
    return app.calculate(data.verified ? data.tasks : [], data.weights, method);
  }

  function compareMethods(data) {
    const rows = Object.entries(app.methods).map(([method, info]) => {
      const result = estimate(data, method);
      const percentage = Number.isFinite(result.percentage) ? result.percentage : null;
      return { method, label: info.label, percentage, letter: app.letter(percentage, data.scale),
        active: method === data.method, missing: result.missing };
    });
    const active = rows.find((row) => row.active);
    for (const row of rows) row.delta = row.percentage !== null && active?.percentage != null ?
      row.percentage - active.percentage : null;
    const notice = !data.verified ? 'A verified term is required for grade estimates.' :
      rows[0].missing.length ? 'Category weights are missing for ' + rows[0].missing.join(', ') + '.' :
      !rows.some((row) => row.percentage !== null) ? 'No usable graded assessments with positive weights for this term.' :
      !data.bucket?.complete || data.error || data.stale ? 'Some scores may be missing or out of date. These estimates use the available data.' : '';
    return { title: data.title, term: data.label, rows, notice };
  }

  function gradeExport(cache, settings, overrides, exportedAt = new Date().toISOString()) {
    const subjects = Object.keys(cache.classes).sort().map((classId) => {
      const entry = cache.classes[classId];
      const name = entry.name || 'Class ' + classId;
      const method = app.methodFor(settings, classId);
      const terms = Object.keys(entry.terms).sort().map((termKey) => {
        const data = gradeInputs(cache, settings, overrides ?? gradeOverrides, classId, termKey);
        const result = estimate(data, method);
        const categoryWeights = Object.fromEntries(Object.entries(data.weights).filter(([, value]) => app.validWeight(value)));
        const byName = new Map(Object.entries(categoryWeights).map(([category, value]) => [app.key(category), value]));
        const assessments = data.tasks.map((task) => {
          const graded = app.validScore(task);
          return {
            id: text(task.id), title: text(task.title), category: text(task.category),
            earnedPoints: graded ? task.earnedPoints : null,
            maxPoints: Number.isFinite(task.maxPoints) && task.maxPoints > 0 ? task.maxPoints : null,
            percentage: graded ? 100 * (task.earnedPoints / task.maxPoints) : null,
            gradeStatus: graded ? 'graded' : task.issue || ['letter', 'rubric', 'invalid', 'missing'].includes(task.gradeKind) ?
              'missing-score' : 'ungraded',
            excluded: Boolean(task.excluded),
            categoryWeight: byName.get(app.key(task.category)) ?? null
          };
        });
        return {
          id: data.bucket.termId ?? null, label: data.label, verified: data.verified,
          completeness: !data.verified ? 'unverified-term' : data.bucket.complete ? 'complete' : 'partial',
          lastSyncedAt: data.bucket.lastScan ? new Date(data.bucket.lastScan).toISOString() : null,
          refreshFailed: Boolean(data.error),
          categoryWeights,
          gradeBoundaries: data.scale.map(([minimumPercentage, letter]) => ({ minimumPercentage, letter })),
          calculatedGrade: { percentage: Number.isFinite(result.percentage) ? result.percentage : null, letter: app.letter(result.percentage, data.scale),
            gradedAssessments: result.count, missingCategories: result.missing },
          assessments
        };
      });
      return { classId, name, selectedMethod: method, terms };
    });
    return { format: 'gradelens-grades', version: 1, exportedAt, subjects };
  }

  const header = ['row_type', 'subject', 'class_id', 'term', 'term_id', 'term_completeness', 'assessment_id', 'assessment',
    'category', 'grade_status', 'excluded', 'earned_points', 'maximum_points', 'assessment_percentage', 'category_weight',
    'selected_method', 'subject_percentage', 'subject_letter_grade', 'exported_at'];
  const percentage = (value) => value === null ? '' : value.toFixed(2);
  function csvCell(value) {
    if (value === null || value === undefined) return '';
    let field = String(value);
    // Keep cached titles, IDs, and labels inert in spreadsheet applications.
    if (typeof value === 'string' && /^(?:\s*[=+\-@]|[\t\r\n])/.test(field)) field = "'" + field;
    return /[",\r\n]/.test(field) ? '"' + field.replaceAll('"', '""') + '"' : field;
  }

  function gradeCSV(report) {
    const lines = [header.join(',')];
    const add = (cells) => lines.push(cells.map(csvCell).join(','));
    for (const subject of report.subjects) {
      for (const term of subject.terms.length ? subject.terms : [null]) {
        const prefix = [subject.name, subject.classId, term?.label, term?.id, term?.completeness];
        const suffix = [app.methods[subject.selectedMethod].label, percentage(term?.calculatedGrade.percentage ?? null),
          term?.calculatedGrade.letter, report.exportedAt];
        if (!term?.assessments.length) add(['subject', ...prefix, ...Array(9).fill(null), ...suffix]);
        for (const row of term?.assessments ?? []) add(['assessment', ...prefix, row.id, row.title, row.category, row.gradeStatus,
          row.excluded, row.earnedPoints, row.maxPoints, percentage(row.percentage),
          row.categoryWeight, ...suffix]);
      }
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  Object.assign(app, { gradeInputs, estimate, compareMethods, gradeExport, gradeCSV, estimateNotice, gradeOverrides });
})();
