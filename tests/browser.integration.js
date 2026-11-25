const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = process.env.MBGC_EXTENSION_ROOT || path.resolve(__dirname, '..');
const browserPath = process.env.MBGC_BROWSER_PATH;
const host = 'https://uia.managebac.com';
const tasksPath = '/student/classes/123/core_tasks';
const physicsPath = '/student/classes/456/core_tasks';
const fixture = (name) => fs.readFile(path.join(__dirname, 'fixtures', name + '.html'), 'utf8');

async function extensionWorld(context, page) {
  const protocol = await context.newCDPSession(page);
  const worlds = [];
  protocol.on('Runtime.executionContextCreated', ({ context: world }) => worlds.push(world));
  await protocol.send('Runtime.enable');
  const isolated = worlds.find((world) => world.name === 'ManageBac Grade Calculator');
  assert.ok(isolated, JSON.stringify(worlds));
  return (expression, options = {}) => protocol.send('Runtime.evaluate', { contextId: isolated.id, expression, ...options });
}


test('unpacked extension synchronizes student routes, handles term and chart changes, and renders responsive views', { timeout: 65000 }, async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'mbgc-browser-'));
  const context = await chromium.launchPersistentContext(userData, {
    ...(browserPath ? { executablePath: browserPath } : { channel: 'chromium' }), headless: true,
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root],
    viewport: { width: 1220, height: 960 }
  });
  try {
    const [tasks, workspace] = await Promise.all([fixture('class-tasks'), fixture('workspace')]);
    const overview = tasks.replace(/<section data-all-tasks>[\s\S]*?<\/section>/, '<section id="latest-activity"><h2>Latest Activity</h2><p>Native activity</p></section>')
      .replace(/<div id="categories-table">[\s\S]*?<\/main>/, '</main>');
    let physics = tasks.replaceAll('/classes/123', '/classes/456')
      .replaceAll('Mathematics Higher Level, Statistics and Mathematical Investigation', 'Physics')
      .replace('8 / 10 pts', '9 / 10 pts');
    let account = '9';
    let physicsRequests = 0;
    const pageErrors = [];
    await context.route(host + '/**', async (request) => {
      const { pathname } = new URL(request.request().url());
      if (pathname === physicsPath) physicsRequests++;
      const body = pathname === tasksPath ? tasks : pathname === physicsPath ? physics :
        pathname === '/student/classes/123' ? overview : workspace;
      await request.fulfill({ contentType: 'text/html; charset=utf-8', body: body.replace('/profile/9', '/profile/' + account) });
    });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(host + tasksPath);
    const waitText = (selector, value) => page.waitForFunction(([selector, value]) =>
      [...document.querySelectorAll(selector), ...(document.querySelector('#mbgc-stage-host')?.shadowRoot?.querySelectorAll(selector) ?? [])].some((item) => item.textContent.includes(value)), [selector, value]);
    await waitText('.mbgc-compact .mbgc-numeral', '74.50%');
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    assert.ok(worker.url().endsWith('/src/storage.js'));
    assert.deepEqual(await page.locator('aside li').evaluateAll((rows) => rows.map((item) => item.textContent.trim())), [
      'Tasks & Deadlines', 'Overall Grades', 'Grade Estimator'
    ]);

    // The synthetic native chart fully replaces its DOM, without replacing All Tasks.
    await page.evaluate(() => {
      document.querySelector('#chart-toggle').addEventListener('click', () => {
        const element = document.querySelector('#native-chart');
        const next = element.cloneNode(false);
        const title = element.textContent.includes('Grade Distribution') ? 'Assessment' : 'Grade Distribution';
        next.innerHTML = '<h3>' + title + '</h3><canvas aria-label="Native chart"></canvas>';
        element.replaceWith(next);
      });
    });
    await page.getByRole('button', { name: 'Switch chart' }).click();
    await page.getByRole('button', { name: 'Switch chart' }).click();
    await page.waitForFunction(() => document.querySelector('#native-chart').textContent === 'Assessment' &&
      Boolean(document.querySelector('[data-all-tasks] .mbgc-card-host').compareDocumentPosition(document.querySelector('#native-chart')) & Node.DOCUMENT_POSITION_FOLLOWING));
    assert.equal(await page.locator('.mbgc-card-host').count(), 1);

    await page.getByRole('link', { name: 'Overall Grades' }).click();
    await waitText('.mbgc-subject .mbgc-numeral', '76.00%');
    assert.equal(await page.locator('.mbgc-subject').count(), 2);
    if (process.env.MBGC_DASHBOARD_SCREENSHOT) await page.screenshot({ path: process.env.MBGC_DASHBOARD_SCREENSHOT, fullPage: true });
    await page.getByLabel('Calculation method').selectOption('points');
    await waitText('.mbgc-subject .mbgc-numeral', '72.25%');
    assert.equal(await page.locator('.mbgc-subject:first-child .mbgc-numeral').count(), 1);

    const second = await context.newPage();
    second.on('pageerror', (error) => pageErrors.push(error.message));
    await second.goto(host + '/student/classes/123');
    await second.waitForFunction(() => document.querySelector('.mbgc-compact .mbgc-numeral')?.textContent === '72.25%');
    assert.equal(await second.locator('#latest-activity').evaluate((node) => node.previousElementSibling.classList.contains('mbgc-card-host')), true);
    await page.bringToFront();
    await page.getByLabel('Calculation method').selectOption('absolute');
    await second.waitForFunction(() => document.querySelector('.mbgc-compact .mbgc-numeral')?.textContent === '72.31%');
    await page.getByRole('link', { name: 'Grade Estimator' }).click();
    await waitText('.mbgc-actual .mbgc-numeral', '72.31%');
    const result = page.locator('.mbgc-predicted-score .mbgc-numeral');
    const before = await result.textContent();
    if (process.env.MBGC_ESTIMATOR_SCREENSHOT) await page.screenshot({ path: process.env.MBGC_ESTIMATOR_SCREENSHOT, fullPage: true });
    const slider = page.getByRole('slider');
    await slider.focus();
    await page.keyboard.press('Home');
    assert.notEqual(await result.textContent(), before);
    assert.match(await page.locator('.mbgc-target-result').textContent(), /Target out of reach/);
    await page.getByRole('button', { name: 'Add hypothetical' }).click();
    assert.equal(await page.locator('.mbgc-scenario').count(), 1);
    await page.getByRole('button', { name: 'Restore actual grades' }).click();
    assert.equal(await result.textContent(), '72.31%');
    await page.getByLabel('Target type').selectOption('letter');
    await page.getByLabel('Letter grade', { exact: true }).selectOption('E');
    await waitText('.mbgc-target-result', 'Already within reach');

    await page.setViewportSize({ width: 340, height: 840 });
    await page.evaluate(() => { document.body.dataset.theme = 'dark'; document.documentElement.style.removeProperty('--primary-color'); });
    await page.waitForFunction(() => {
      const stage = document.querySelector('#mbgc-stage-host')?.shadowRoot?.querySelector('.mbgc-stage');
      return stage?.dataset.theme === 'dark' && stage.style.getPropertyValue('--mbgc-accent') === 'rgb(255 210 140)';
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.mbgc-track-fill').first().evaluate((node) => getComputedStyle(node).transitionDuration), '0s');
    assert.equal(await page.locator('.mbgc-page').evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
    await page.getByRole('link', { name: 'Overall Grades' }).click();
    await page.locator('.mbgc-subject summary').first().click();
    assert.equal(await page.locator('.mbgc-page').evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);

    await page.getByRole('button', { name: 'Back to ManageBac' }).click();
    await page.getByRole('link', { name: 'Files', exact: true }).waitFor();
    await page.locator('#task-one .points').evaluate((node) => { node.textContent = '10 / 10 pts'; });
    await waitText('.mbgc-compact .mbgc-numeral', '76.92%');
    await waitText('.mbgc-compact-note', 'Grade updated');
    await page.locator('select[name="term_id"]').selectOption('72');
    await waitText('.mbgc-compact .mbgc-numeral', 'No grade available');
    await page.evaluate(() => {
      const list = document.querySelector('[data-task-list]');
      list.dataset.termId = '72';
      list.querySelector('.points').textContent = '0 / 10 pts';
    });
    await waitText('.mbgc-compact .mbgc-numeral', '53.85%');
    assert.equal(await page.locator('.mbgc-card-host').count(), 1);

    // Let any dashboard-triggered refresh finish, then test an explicit manual refresh.
    await page.getByRole('link', { name: 'Overall Grades' }).click();
    await page.getByRole('button', { name: 'Refresh now' }).waitFor();
    physics = physics.replace('9 / 10 pts', '10 / 10 pts');
    await worker.evaluate(async () => {
      await chrome.storage.session.remove('mbgc:cache:uia.managebac.com:9:refresh');
    });
    await page.getByLabel('Academic term').selectOption('term:71');
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await waitText('.mbgc-feedback', 'Checked');
    const physicsRow = page.locator('.mbgc-subject', { hasText: 'Physics' });
    assert.equal(await physicsRow.locator('.mbgc-numeral').textContent(), '76.92%');

    // Move the page clock forward to check the default periodic refresh with no button click.
    const evaluateExtension = await extensionWorld(context, page);
    await evaluateExtension('Date.now = (() => { const now = Date.now; return () => now() + 315000; })()');
    await worker.evaluate(async () => {
      await chrome.storage.session.remove('mbgc:cache:uia.managebac.com:9:refresh');
    });
    const priorRequests = physicsRequests;
    physics = physics.replace('10 / 10 pts', '7 / 10 pts');
    await page.waitForFunction(() => [...(document.querySelector('#mbgc-stage-host')?.shadowRoot?.querySelectorAll('.mbgc-subject .mbgc-numeral') ?? [])]
      .some((item) => item.textContent === '70.00%'), null, { timeout: 20000 });
    assert.ok(physicsRequests > priorRequests);

    account = '19';
    await second.reload();
    await second.waitForFunction(() => document.querySelector('.mbgc-compact .mbgc-numeral')?.textContent === 'No grade available');
    const stored = await worker.evaluate(async () => (await loadAccount('9')).cache);
    assert.ok(stored.classes['123']);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test('desktop integration regression with a narrow native wrapper and asynchronous dropdown', { timeout: 45000 }, async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'mbgc-live-fixture-'));
  const context = await chromium.launchPersistentContext(userData, {
    ...(browserPath ? { executablePath: browserPath } : { channel: 'chromium' }), headless: true,
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root],
    viewport: { width: 1400, height: 860 }
  });
  try {
    const tasks = await fixture('desktop-integration');
    const overview = tasks.replace(/<div class="class-panel">[\s\S]*?<table>/, '<section id="latest"><div class="title">Latest Activity</div></section><table>');
    const lettersOnly = tasks.replace('<meta name="current-student-id" content="9">', '')
      .replace('<span class="score-points">18 out of 20 points</span>', '')
      .replace('<span data-earned-points="0" data-max-points="10"></span>', '');
    let useLettersOnly = false;
    await context.route(host + '/**', (request) => {
      const { pathname } = new URL(request.request().url());
      const body = pathname.endsWith('/123') ? overview : useLettersOnly ? lettersOnly : tasks;
      return request.fulfill({ contentType: 'text/html', body,
        headers: { 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'" } });
    });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    await page.goto(host + tasksPath);
    await page.getByRole('link', { name: 'Overall Grades' }).click();
    await page.getByRole('heading', { name: 'Overall Grades' }).waitFor();
    const widths = await page.locator('.mbgc-header').evaluate((node) => ({
      header: Math.round(node.getBoundingClientRect().width),
      viewport: innerWidth,
      utility: document.querySelector('#content').getBoundingClientRect().width,
      utilityDisplay: getComputedStyle(document.querySelector('#content')).display,
      headerMax: getComputedStyle(node).maxWidth,
      isolated: node.getRootNode() instanceof ShadowRoot
    }));
    if (process.env.MBGC_MEASURE_BASELINE) {
      console.log(JSON.stringify(widths));
      assert.ok(widths.header < 120);
      return;
    }
    assert.equal(widths.utility, 64);
    assert.ok(widths.header >= widths.viewport * .65, JSON.stringify(widths));
    assert.equal(widths.isolated, true);
    assert.equal(widths.headerMax, 'none');
    await page.getByText('54.00%', { exact: true }).waitFor();
    const subject = page.locator('.mbgc-subject').filter({ hasText: '54.00%' });
    await subject.getByText('Task list unverified', { exact: true }).waitFor();
    await subject.locator('summary').click();
    await subject.getByText(/could not confirm that the task list includes every assessment/).waitFor();
    await page.getByText('Sync diagnostics', { exact: true }).click();
    const { version } = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
    await page.getByText('Extension version ' + version, { exact: true }).waitFor();
    await page.getByText(/3 assessments read of 3 candidates · 2 with usable points/).waitFor();
    await page.getByRole('link', { name: 'Grade Estimator' }).click();
    await page.locator('.mbgc-actual .mbgc-numeral', { hasText: '54.00%' }).waitFor();
    assert.equal(await page.getByLabel('Academic term').inputValue(), 'current');
    await page.getByLabel('Academic term').locator('option[value="term:671"]').waitFor({ state: 'attached' });
    assert.ok((await page.locator('.mbgc-header').boundingBox()).width >= widths.viewport * .65);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForFunction(() => {
      const stage = document.querySelector('#mbgc-stage-host');
      return stage.getBoundingClientRect().width === innerWidth &&
        stage.shadowRoot.querySelector('.mbgc-page').scrollWidth <= innerWidth;
    });
    await page.getByRole('button', { name: 'Back to ManageBac' }).click();
    await page.setViewportSize({ width: 1400, height: 860 });
    await page.locator('.class-panel .mbgc-compact .mbgc-numeral', { hasText: '54.00%' }).waitFor();
    assert.equal(await page.locator('.chart-frame').evaluate((node) => node.previousElementSibling.classList.contains('mbgc-card-host')), true);
    await page.evaluate(() => {
      const panel = document.querySelector('.chart-frame');
      const placeholder = document.createElement('div');
      placeholder.id = 'chart-loading';
      panel.replaceWith(placeholder);
      window.nextChart = panel.cloneNode(true);
      window.nextChart.querySelector('.title').textContent = 'Grade Distribution';
    });
    await page.waitForFunction(() => document.querySelector('.class-panel .mbgc-card-host') &&
      !document.querySelector('.chart-frame'));
    await page.evaluate(() => document.querySelector('#chart-loading').replaceWith(window.nextChart));
    await page.locator('.chart-frame .title', { hasText: 'Grade Distribution' }).waitFor();
    assert.equal(await page.locator('.class-panel .mbgc-card-host').count(), 1);

    await page.evaluate(() => {
      document.querySelector('[role="combobox"]').textContent = 'Semester 2';
      const [previous, current] = document.querySelectorAll('[role="option"]');
      previous.setAttribute('aria-selected', 'false');
      current.setAttribute('aria-selected', 'true');
      document.querySelector('#term-results').setAttribute('aria-busy', 'true');
    });
    await page.locator('.mbgc-compact').getByText(/still loading/).waitFor();
    await page.evaluate(() => {
      const results = document.querySelector('#term-results');
      results.dataset.termId = '672';
      results.querySelector('.score-points').textContent = '20 / 20';
      results.removeAttribute('aria-busy');
    });
    await page.locator('.mbgc-compact .mbgc-numeral', { hasText: '60.00%' }).waitFor();
    await page.getByRole('link', { name: 'Overall Grades' }).click();
    await page.locator('.mbgc-subject .mbgc-numeral', { hasText: '60.00%' }).waitFor();
    assert.equal(await page.getByLabel('Academic term').inputValue(), 'current');
    await page.getByLabel('Academic term').selectOption('term:672');
    await page.getByRole('link', { name: 'Grade Estimator' }).click();
    assert.equal(await page.getByLabel('Academic term').inputValue(), 'term:672');
    await page.getByRole('button', { name: 'Back to ManageBac' }).click();
    await page.goto(host + '/student/classes/123');
    await page.locator('.mbgc-compact .mbgc-numeral', { hasText: '60.00%' }).waitFor();

    await page.goto(host + tasksPath);
    await page.locator('.mbgc-compact .mbgc-numeral', { hasText: '54.00%' }).waitFor();
    const evaluateExtension = await extensionWorld(context, page);
    await evaluateExtension(`globalThis.originalSend = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = (message) => message.type === 'mbgc:scan'
        ? Promise.reject(new Error('simulated cache write failure')) : globalThis.originalSend(message)`);
    await page.evaluate(() => {
      document.querySelector('#term-results').setAttribute('data-total-count', '3');
      document.querySelector('.score-points').textContent = '19 / 20';
    });
    await page.locator('.mbgc-compact .mbgc-numeral', { hasText: '57.00%' }).waitFor();
    await page.locator('.mbgc-compact').getByText(/Grade cache unavailable/).waitFor();
    await evaluateExtension('chrome.runtime.sendMessage = globalThis.originalSend');
    await page.getByRole('link', { name: 'Overall Grades' }).click();
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await page.getByText('Sync diagnostics', { exact: true }).click();
    await page.getByText('Verified student grade cache', { exact: true }).waitFor();

    useLettersOnly = true;
    await page.goto(host + tasksPath);
    await page.locator('.mbgc-compact').getByText(/letter grades or rubric criteria alone cannot produce a percentage/i).waitFor();
    await page.getByRole('link', { name: 'Overall Grades' }).click();
    await page.getByText(/letter grades or rubric criteria alone cannot produce a percentage/i).waitFor();
    await page.getByText('Sync diagnostics', { exact: true }).click();
    await page.getByText(/current document only · student identity/i).waitFor();
  } finally {
    await context.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test('automatically discovers enrolled classes, keeps PE consistent, and coalesces grade mutations across tabs', { timeout: 45000 }, async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'mbgc-roster-test-'));
  const context = await chromium.launchPersistentContext(userData, {
    ...(browserPath ? { executablePath: browserPath } : { channel: 'chromium' }), headless: true,
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root],
    viewport: { width: 1280, height: 850 }
  });
  try {
    context.setDefaultTimeout(8000);
    const account = '<meta name="current-student-id" content="28">';
    const links = '<nav><a href="/student/tasks_and_deadlines">Tasks &amp; Deadlines</a>' +
      '<a href="/student/classes">My Classes</a><a href="/student/classes?tab=all">Browse All Classes</a></nav>';
    const shell = (content) => `<!doctype html><html><head>${account}</head><body>${links}<main>${content}</main></body></html>`;
    const pePath = '/student/classes/321/core_tasks';
    const mathPath = '/student/classes/654/core_tasks';
    const artPath = '/student/classes/987/core_tasks';
    const oldPE = pePath + '?term_id=812';
    const home = '/student/dashboard';
    const lesson = (path, name, term, tasks, historical = '') => shell(
      `<h1 class="class-title">${name}</h1><section data-all-tasks><h2>All Tasks</h2>
      <form action="${path}"><select name="term_id">
      <option value="${term}" selected>Semester 1</option>${historical}</select></form>
      <div class="chart-frame"><h3>Assessment</h3><canvas></canvas></div>
      <div data-task-list="all" data-term-id="${term}" data-total-count="${tasks.length}">${tasks.map(([id, title, points]) =>
        `<article class="short-assignment"><a href="${path}/${id}">${title}</a><span class="task-category">Coursework</span><div class="task-score">
        ${points === null ? '<span class="submission-status">Pending</span>' : `<span class="points">${points}</span>`}</div></article>`
      ).join('')}</div></section>
      <div id="categories-table"><div class="list-item"><div class="cell">Coursework</div><div class="cell">100%</div></div></div>
      <div id="unrelated"></div>`);
    const pe = lesson(pePath, 'Physical Education AS', '811',
      [['1', 'Push Ups', '100 / 100'], ['2', '1 mile run', '100 / 100']], '<option value="812">Semester 2</option>');
    const pendingTasks = Array.from({ length: 8 }, (_, i) => [String(i + 10), 'Upcoming ' + i, null]);
    const math = lesson(mathPath, 'Mathematics', '60',
      [['1', 'Quiz', '13 / 30'], ['2', 'Test', '22 / 24'], ['3', 'Project', '15 / 30'], ['4', 'Exam', '17 / 20'], ...pendingTasks]);
    const art = lesson(artPath, 'Visual Arts', '901', []).replace('data-total-count="0"', '');
    const requests = new Map();
    let inFlight = 0;
    let peak = 0;
    let backgroundEmptyPE = false;
    await context.route(host + '/**', async (intercepted) => {
      const request = intercepted.request();
      const url = new URL(request.url());
      const source = url.pathname + url.search;
      const background = !request.isNavigationRequest();
      if (background) {
        const entries = requests.get(source) ?? [];
        entries.push(request.headers()['if-none-match']);
        requests.set(source, entries);
        peak = Math.max(peak, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 190));
      }
      try {
        const etag = source === mathPath ? '"math-v1"' : undefined;
        if (etag && request.headers()['if-none-match'] === etag) {
          await intercepted.fulfill({ status: 304, headers: { etag } });
          return;
        }
        const body = source === '/student/classes' ? shell(
          '<a href="/student/classes/321">Physical Education AS</a><a href="/student/classes?page=2" rel="next">Next</a>') :
          source === '/student/classes?page=2' ? shell('<a href="/student/classes/654">Mathematics</a><a href="/student/classes/987">Visual Arts</a>') :
          source === mathPath ? math : source === artPath ? art :
          source === oldPE ? lesson(pePath, 'Physical Education AS', '812', [['3', 'Fitness test', '75 / 100']]) :
          url.pathname === pePath ? (background && backgroundEmptyPE ? lesson(pePath, 'Physical Education AS', '811', []) : pe) :
          shell('<h1>Student workspace</h1>');
        await intercepted.fulfill({ contentType: 'text/html', headers: etag ? { etag } : {}, body });
      } finally {
        if (background) inFlight--;
      }
    });

    const dashboard = await context.newPage();
    await dashboard.goto(host + home);
    await dashboard.getByRole('link', { name: 'Overall Grades' }).click();
    const row = (title) => dashboard.locator('.mbgc-subject', { hasText: title });
    const grade = (title, value) => row(title).locator('.mbgc-numeral', { hasText: value }).waitFor();
    const peRow = row('Physical Education AS');
    await grade('Physical Education AS', '100.00%');
    await peRow.getByText(/2 graded assessments/).waitFor();
    await grade('Mathematics', '67.50%');
    await row('Mathematics').getByText(/4 graded assessments/).waitFor();
    await row('Visual Arts').locator('summary').click();
    await row('Visual Arts').getByText(/No verifiable task scores in the returned HTML/).waitFor();
    await dashboard.getByLabel('Academic term').locator('option[value="term:812"]').waitFor({ state: 'attached' });
    assert.ok(requests.has('/student/classes?page=2'));
    assert.ok(requests.has(oldPE));
    assert.ok(!requests.has('/student/classes?tab=all'));
    assert.ok(peak >= 2 && peak <= 3, 'unexpected concurrent request count: ' + peak);
    await dashboard.getByLabel('Academic term').selectOption('term:812');
    await grade('Physical Education AS', '75.00%');
    await dashboard.getByLabel('Academic term').selectOption('current');
    await grade('Physical Education AS', '100.00%');

    const native = await context.newPage();
    await native.goto(host + pePath);
    const compactGrade = (value) => native.locator('.mbgc-compact .mbgc-numeral', { hasText: value }).waitFor();
    await compactGrade('100.00%');
    await native.getByRole('link', { name: 'Overall Grades' }).click();
    await native.locator('.mbgc-subject', { hasText: 'Physical Education AS' }).locator('.mbgc-numeral', { hasText: '100.00%' }).waitFor();
    await native.getByRole('button', { name: 'Back to ManageBac' }).click();

    const evaluateExtension = await extensionWorld(context, native);
    await evaluateExtension(`globalThis.mbgcCounters = { full: 0, score: 0, writes: 0 };
      const oldScan = MBGC.scan, oldScores = MBGC.readScoreChanges, oldSend = chrome.runtime.sendMessage;
      MBGC.scan = (...args) => { mbgcCounters.full++; return oldScan(...args); };
      MBGC.readScoreChanges = (...args) => { mbgcCounters.score++; return oldScores(...args); };
      chrome.runtime.sendMessage = (message) => { if (message.type === 'mbgc:scan') mbgcCounters.writes++; return oldSend(message); };
    `);
    await native.evaluate(async () => {
      const unrelated = document.querySelector('#unrelated');
      const chart = document.querySelector('canvas');
      const score = document.querySelector('.points');
      for (let index = 0; index < 80; index++) {
        unrelated.textContent = 'Unrelated ' + index;
        chart.style.opacity = String(.1 + index / 100);
        if (index >= 55) score.textContent = String(100 - index) + ' / 100';
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      score.textContent = '90 / 100';
    });
    await compactGrade('95.00%');
    await grade('Physical Education AS', '95.00%');
    const counters = await evaluateExtension('JSON.stringify(mbgcCounters)');
    assert.deepEqual(JSON.parse(counters.result.value), { full: 0, score: 1, writes: 1 });

    backgroundEmptyPE = true;
    await dashboard.bringToFront();
    const worker = context.serviceWorkers()[0];
    await worker.evaluate(() => chrome.storage.session.remove('mbgc:cache:uia.managebac.com:28:refresh'));
    await dashboard.getByRole('button', { name: 'Refresh now' }).click();
    await dashboard.getByText(/\d+ unchanged/).waitFor();
    await grade('Physical Education AS', '95.00%');
    await peRow.getByText(/2 graded assessments/).waitFor();
    await peRow.locator('summary').click();
    await peRow.getByText(/No verifiable task scores in the returned HTML/).waitFor();
    await peRow.getByText(/Last successful sync/).waitFor();
    assert.deepEqual(requests.get(mathPath), [undefined, '"math-v1"']);
  } finally {
    await context.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test('mixed subjects sync from the roster and distinguish no grade from a genuine zero', { timeout: 30000 }, async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'mbgc-subjects-'));
  const context = await chromium.launchPersistentContext(userData, {
    ...(browserPath ? { executablePath: browserPath } : { channel: 'chromium' }), headless: true,
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root],
    viewport: { width: 1160, height: 820 }
  });
  try {
    const { subjects, page, tasksPath, tasksPage, rosterPage } = require('./fixtures/subjects');
    const paths = new Map(subjects.map((subject) => [tasksPath(subject), subject]));
    await context.route(host + '/**', (intercepted) => {
      const pathname = new URL(intercepted.request().url()).pathname;
      const subject = paths.get(pathname);
      const body = pathname === '/student/classes' ? rosterPage() : subject ? tasksPage(subject) : page('<h1>Workspace</h1>');
      return intercepted.fulfill({ contentType: 'text/html', body });
    });
    context.setDefaultTimeout(8000);
    const tab = await context.newPage();
    await tab.goto(host + '/student/dashboard');
    await tab.getByRole('link', { name: 'Overall Grades' }).click();
    const row = (name) => tab.locator('.mbgc-subject').filter({ has: tab.getByRole('heading', { name, exact: true }) });
    for (const method of ['percentage', 'points', 'absolute']) {
      await tab.getByLabel('Calculation method').selectOption(method);
      for (const { name, grades } of subjects) {
        const expected = grades[method] === null ? 'No grade available' : grades[method].toFixed(2) + '%';
        await row(name).locator('.mbgc-numeral', { hasText: expected }).waitFor();
      }
    }
    await row('Art').locator('summary').click();
    await row('Art').getByText('Rubric only', { exact: true }).waitFor();
    await row('English Literature').locator('summary').click();
    await row('English Literature').getByText('A− (letter only)', { exact: true }).waitFor();
    const art = subjects.find(({ name }) => name === 'Art');
    await tab.goto(host + tasksPath(art));
    await tab.locator('.mbgc-compact').getByText('No grade available', { exact: true }).waitFor();
    await tab.getByRole('link', { name: 'Grade Estimator' }).click();
    await tab.getByLabel('Subject').selectOption(art.id);
    await tab.locator('.mbgc-actual').getByText('No grade available', { exact: true }).waitFor();
  } finally {
    await context.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test('render-only and linked results sync automatically and verified grades survive a cold cache read', { timeout: 40000 }, async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'mbgc-rendered-results-'));
  const context = await chromium.launchPersistentContext(userData, {
    ...(browserPath ? { executablePath: browserPath } : { channel: 'chromium' }), headless: true,
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root],
    viewport: { width: 1200, height: 860 }
  });
  try {
    const { page: html, tasksPath, tasksPage } = require('./fixtures/subjects');
    const rendered = { id: '512', name: 'Mathematics', categories: [['Exercises', 100]],
      tasks: [['Exercises', '<div class="task-score"><span class="points">42 / 50</span></div>']] };
    const linked = { id: '513', name: 'Physics', categories: [['Practical', 100]],
      tasks: [['Practical', '<span class="letter-grade">B</span>']] };
    const renderedPath = tasksPath(rendered);
    const linkedPath = tasksPath(linked);
    const published = tasksPage(rendered);
    const scripts = published.slice(published.indexOf('<section'), published.indexOf('</main>'))
      .replace(/<select[\s\S]*?<\/select>/, '<button type="button" role="combobox" aria-controls="terms-list">Semester 1 (current)</button>');
    const placeholder = scripts.replace('<span class="points">42 / 50</span>', '<span>Pending</span>');
    const shell = html(`<h1 class="class-title">Mathematics</h1>${placeholder}
      <script>
      document.addEventListener('click', (event) => {
        if (!event.target.matches('[role="combobox"]')) return;
        document.body.insertAdjacentHTML('beforeend', '<div id="terms-list" role="listbox"><span role="option" data-term-id="term-512" aria-selected="true">Semester 1 (current)</span></div>');
      });
      setTimeout(() => { document.querySelector('main').innerHTML = ${JSON.stringify(scripts)}; }, 1250);
      </script>`);
    const linkedMarkup = tasksPage(linked).replace('>Assessment 1</a>', ' data-assessment-result-link>Assessment 1</a>');
    let fail = false;
    let frameReads = 0;
    let detailReads = 0;
    let detailPoints = 31;
    let rosterReads = 0;
    await context.route(host + '/**', (intercepted) => {
      const request = intercepted.request();
      const path = new URL(request.url()).pathname;
      if (path === renderedPath && request.isNavigationRequest() && request.frame().parentFrame()) frameReads++;
      if (path === linkedPath + '/1') detailReads++;
      if (path === '/student/classes') rosterReads++;
      if (fail && [renderedPath, linkedPath, linkedPath + '/1'].includes(path) && !request.isNavigationRequest()) {
        return intercepted.fulfill({ status: 503, body: 'Unavailable' });
      }
      const body = path === '/student/classes' ? html(
        '<a href="/student/classes/512">Mathematics</a><a href="/student/classes/513">Physics</a>') :
        path === renderedPath ? shell :
        path === linkedPath ? linkedMarkup :
        path === linkedPath + '/1' ? html(`<div data-assessment-result><span class="points">${detailPoints} / 40</span></div>`) :
        html('<h1>Workspace</h1>');
      return intercepted.fulfill({ contentType: 'text/html', body });
    });
    context.setDefaultTimeout(9000);
    const tab = await context.newPage();
    const second = await context.newPage();
    await tab.goto(host + '/student/dashboard');
    await second.goto(host + '/student/dashboard');
    await tab.bringToFront();
    await tab.getByRole('link', { name: 'Overall Grades' }).click();
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const otherWorld = await extensionWorld(context, second);
    const otherLease = await otherWorld(`chrome.runtime.sendMessage({ type: 'mbgc:lease', account: '81', manual: true })`,
      { awaitPromise: true, returnByValue: true });
    assert.equal(otherLease.exceptionDetails, undefined);
    assert.equal(otherLease.result.value.value, null);
    const row = (name) => tab.locator('.mbgc-subject', { hasText: name });
    await row('Mathematics').locator('.mbgc-numeral', { hasText: '84.00%' }).waitFor();
    await row('Physics').locator('.mbgc-numeral', { hasText: '77.50%' }).waitFor();
    assert.equal(await row('Mathematics').locator('.mbgc-categories').count(), 0);
    await row('Mathematics').locator('summary').click();
    await row('Mathematics').getByText(/Source: rendered student page/).waitFor();
    assert.equal(frameReads, 1);
    assert.equal(detailReads, 1);
    assert.equal(rosterReads, 1);
    await tab.getByRole('button', { name: 'Refresh now' }).waitFor();
    const idle = await tab.evaluate(async () => {
      let writes = 0;
      const observer = new MutationObserver((records) => { writes += records.length; });
      observer.observe(document.querySelector('main'), { attributes: true, attributeFilter: ['class'] });
      await new Promise((resolve) => setTimeout(resolve, 600));
      observer.disconnect();
      return writes;
    });
    assert.equal(idle, 0, 'an idle dashboard must not repeatedly mutate the native container');
    await tab.getByRole('link', { name: 'Grade Estimator' }).click();
    await tab.getByLabel('Subject').selectOption('512');
    await tab.locator('.mbgc-actual .mbgc-numeral', { hasText: '84.00%' }).waitFor();
    await tab.goto(host + '/student/classes/512');
    await tab.locator('.mbgc-compact .mbgc-numeral', { hasText: '84.00%' }).waitFor();
    await tab.goto(host + renderedPath);
    await tab.getByRole('combobox').click();
    await tab.locator('.mbgc-compact .mbgc-numeral', { hasText: '84.00%' }).waitFor();
    await tab.getByRole('link', { name: 'Overall Grades' }).click();
    await row('Mathematics').locator('.mbgc-numeral', { hasText: '84.00%' }).waitFor();

    detailPoints = 32;
    await worker.evaluate(() => chrome.storage.session.remove('mbgc:cache:uia.managebac.com:81:refresh'));
    await tab.getByRole('button', { name: 'Refresh now' }).click();
    await row('Physics').locator('.mbgc-numeral', { hasText: '80.00%' }).waitFor();
    await tab.getByRole('button', { name: 'Refresh now' }).waitFor();
    fail = true;
    await worker.evaluate(async () => {
      accountStates.delete('81');
      await chrome.storage.session.remove('mbgc:cache:uia.managebac.com:81:refresh');
    });
    await tab.goto(host + '/student/dashboard#mbgc-overall-grades');
    await row('Mathematics').locator('.mbgc-numeral', { hasText: '84.00%' }).waitFor();
    await row('Physics').locator('.mbgc-numeral', { hasText: '80.00%' }).waitFor();
    // Recent sources are reused automatically. Force a recheck to exercise a failed refresh.
    await tab.getByRole('button', { name: 'Refresh now' }).click();
    await tab.getByText(/pages could not be verified/i).waitFor();
    await row('Mathematics').locator('summary').click();
    await row('Mathematics').getByText(/Cache · last read from rendered student page/).waitFor();
    await row('Mathematics').getByText(/Last successful sync/).waitFor();
  } finally {
    await context.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test('generic self-profile scopes automatic grades and blocks a mid-refresh account switch', { timeout: 20000 }, async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'mbgc-profile-identity-'));
  const browser = await chromium.launchPersistentContext(userData, {
    ...(browserPath ? { executablePath: browserPath } : { channel: 'chromium' }), headless: true,
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root]
  });
  try {
    const classPage = (await fixture('class-tasks')).replace('href="/student/profile/9"', 'href="/student/profile"')
      .replace('<a href="/student/classes/456">Physics</a>', '');
    const studentPage = (body) => '<header><a href="/student/profile">Manage Your Profile</a></header>' +
      '<nav><a href="/student/tasks_and_deadlines">Tasks &amp; Deadlines</a></nav><main>' + body + '</main>';
    let email = 'fixture-one@example.test';
    let switchDuringRead = false;
    await browser.route(host + '/**', (intercepted) => {
      const { pathname } = new URL(intercepted.request().url());
      let body = studentPage('<a href="/student/classes/123">Mathematics</a>');
      if (pathname === '/student/profile') body = studentPage('<a href="/student/profile/edit">Edit Profile</a>');
      if (pathname === '/student/profile/edit') body = studentPage('<form><input type="email" value="' + email + '"></form>');
      if (pathname === tasksPath) {
        if (switchDuringRead) email = 'fixture-two@example.test';
        body = switchDuringRead ? classPage.replace('8 / 10 pts', '10 / 10 pts') : classPage;
      }
      return intercepted.fulfill({ body, contentType: 'text/html' });
    });
    browser.setDefaultTimeout(5000);
    const tab = await browser.newPage();
    await tab.goto(host + '/student/dashboard');
    await tab.getByRole('link', { name: 'Overall Grades' }).click();
    await tab.getByText('74.50%', { exact: true }).waitFor();
    await tab.getByRole('button', { name: 'Refresh now' }).waitFor();
    const worker = browser.serviceWorkers()[0];
    const account = 'profile-' + require('node:crypto').createHash('sha256').update(host + '\n' + email).digest('hex');
    await worker.evaluate(async (key) => chrome.storage.session.remove('mbgc:cache:uia.managebac.com:' + key + ':refresh'), account);
    switchDuringRead = true;
    await tab.getByRole('button', { name: 'Refresh now' }).click();
    await tab.getByText(/signed-in profile could not be reverified/i).waitFor();
    const cachedPoints = await worker.evaluate(async (key) =>
      (await loadAccount(key)).cache.classes['123'].terms['term:71'].records['1'].earnedPoints, account);
    assert.equal(cachedPoints, 8);
    assert.equal(await tab.getByText('74.50%', { exact: true }).count(), 0);
  } finally {
    await browser.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});
