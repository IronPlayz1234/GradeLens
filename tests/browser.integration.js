const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = process.env.MBGC_EXTENSION_ROOT || path.resolve(__dirname, '..');
const extensionName = JSON.parse(require('node:fs').readFileSync(path.join(root, 'manifest.json'), 'utf8')).name;
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
  const isolated = worlds.find((world) => world.name === extensionName);
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
    if (process.env.MBGC_DASHBOARD_SCREENSHOT) {
      await page.getByRole('button', { name: 'Skip guide' }).click();
      const subject = page.locator('.mbgc-subject summary').first();
      await subject.click();
      await page.locator('.mbgc-category-metrics').first().waitFor();
      await page.screenshot({ path: process.env.MBGC_DASHBOARD_SCREENSHOT, fullPage: true, animations: 'disabled' });
      await subject.click();
    }
    await page.getByLabel('Global calculation method', { exact: true }).selectOption('points');
    await waitText('.mbgc-subject .mbgc-numeral', '72.25%');
    assert.equal(await page.locator('.mbgc-subject:first-child .mbgc-numeral').count(), 1);

    const second = await context.newPage();
    second.on('pageerror', (error) => pageErrors.push(error.message));
    await second.goto(host + '/student/classes/123');
    await second.waitForFunction(() => document.querySelector('.mbgc-compact .mbgc-numeral')?.textContent === '72.25%');
    assert.equal(await second.locator('#latest-activity').evaluate((node) => node.previousElementSibling.classList.contains('mbgc-card-host')), true);
    await page.bringToFront();
    await page.getByLabel('Global calculation method', { exact: true }).selectOption('absolute');
    await second.waitForFunction(() => document.querySelector('.mbgc-compact .mbgc-numeral')?.textContent === '72.31%');
    await page.getByRole('link', { name: 'Grade Estimator' }).click();
    await waitText('.mbgc-actual .mbgc-numeral', '72.31%');
    const result = page.locator('.mbgc-predicted-score .mbgc-numeral');
    await page.getByRole('button', { name: 'Change an existing grade' }).click();
    await page.getByLabel('Assessment', { exact: true }).selectOption('1');
    assert.equal(await page.getByLabel('Earned points').inputValue(), '8');
    assert.equal(await page.getByLabel('Maximum points').inputValue(), '10');
    assert.equal(await result.textContent(), '72.31%');
    await page.getByRole('button', { name: 'Try a future grade' }).click();
    await page.getByText('What score do I need?', { exact: true }).click();
    const before = await result.textContent();
    if (process.env.MBGC_ESTIMATOR_SCREENSHOT) await page.screenshot({ path: process.env.MBGC_ESTIMATOR_SCREENSHOT, fullPage: true, animations: 'disabled' });
    const slider = page.getByRole('slider');
    await slider.focus();
    await page.keyboard.press('Home');
    assert.notEqual(await result.textContent(), before);
    assert.match(await page.locator('.mbgc-target-result').textContent(), /Target out of reach/);
    await page.getByRole('button', { name: 'Add to prediction' }).click();
    assert.equal(await page.locator('.mbgc-scenario').count(), 1);
    await page.getByRole('button', { name: 'Clear predictions' }).click();
    assert.equal(await result.textContent(), '72.31%');
    await page.getByLabel('Target type').selectOption('letter');
    await page.getByLabel('Letter grade', { exact: true }).selectOption('E');
    await waitText('.mbgc-target-result', 'Already within reach');

    await page.setViewportSize({ width: 340, height: 840 });
    await page.emulateMedia({ colorScheme: 'dark' });
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
    await page.getByText('Sync details', { exact: true }).click();
    await page.locator('.mbgc-diagnostics').getByText(/Checked \d+ student pages/).waitFor();
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
    await page.getByRole('heading', { name: 'Overall Grades', exact: true }).waitFor();
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
    const info = subject.getByRole('button', { name: 'About this grade' });
    await info.focus();
    await subject.getByRole('tooltip').getByText(/Some assignments may not have been included/).waitFor();
    await info.press('Escape');
    await subject.locator('summary').click();
    await subject.getByText(/could not confirm that the task list includes every assessment/).waitFor();
    await page.getByText('Sync details', { exact: true }).click();
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
    await page.getByText('Sync details', { exact: true }).click();
    await page.getByText('Verified student grade cache', { exact: true }).waitFor();

    useLettersOnly = true;
    await page.goto(host + tasksPath);
    await page.locator('.mbgc-compact').getByText(/letter grades or rubric criteria alone cannot produce a percentage/i).waitFor();
    await page.getByRole('link', { name: 'Overall Grades' }).click();
    await page.getByText('Sync details', { exact: true }).click();
    await page.getByText(/letter grades or rubric criteria alone cannot produce a percentage/i).waitFor();
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
    await dashboard.getByText('Sync details', { exact: true }).click();
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
      await tab.getByLabel('Global calculation method', { exact: true }).selectOption(method);
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
    await tab.getByLabel('Subject', { exact: true }).selectOption(art.id);
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
    await tab.getByLabel('Subject', { exact: true }).selectOption('512');
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
    await tab.getByText('Sync details', { exact: true }).click();
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
    await tab.getByText(/couldn’t finish updating grades/i).waitFor();
    await tab.getByText('Sync details', { exact: true }).click();
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

test('cold sync shows real milestones and Retry while warm sync retains grades and sidebar badges', { timeout: 22000 }, async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'mbgc-ux-sync-'));
  const browser = await chromium.launchPersistentContext(userData, {
    ...(browserPath ? { executablePath: browserPath } : { channel: 'chromium' }), headless: true,
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root], viewport: { width: 950, height: 780 }
  });
  let resumeRoster, resumeClass, resumeWarm;
  const rosterGate = new Promise((resolve) => { resumeRoster = resolve; });
  const classGate = new Promise((resolve) => { resumeClass = resolve; });
  const warmGate = new Promise((resolve) => { resumeWarm = resolve; });
  try {
    const className = 'Further Mathematics and Advanced Problem Solving';
    const shell = (body, link = '') => `<meta name="current-student-id" content="28">
      <aside class="sidebar" style="width:130px"><nav><a href="/student/tasks_and_deadlines">Tasks &amp; Deadlines</a>
        <a href="/student/classes">My Classes</a>${link}</nav></aside><main>${body}</main>`;
    const classLink = `<a href="/student/classes/123">${className}</a>`;
    const tasks = shell(`<h1 class="class-title">${className}</h1><section data-all-tasks><h2>All Tasks</h2>
      <select name="term_id"><option value="12">Semester 1</option></select><h3>Assessment</h3>
      <div data-task-list="all" data-term-id="12" data-total-count="2">
        <div class="task-card" data-category="Coursework"><a href="${tasksPath}/1">Extended project</a><span class="points">90 / 100</span></div>
        <div class="task-card" data-category="Coursework"><a href="${tasksPath}/2">Quiz</a><span class="points">1 / 10</span></div>
      </div><table id="categories-table"><tr><td>Coursework</td><td>100</td></tr></table></section>`);
    let failClass = true;
    let holdWarmClass = false;
    await browser.route(host + '/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/student/classes') {
        await rosterGate;
        return route.fulfill({ contentType: 'text/html', body: shell(classLink) });
      }
      if (pathname === tasksPath) {
        await classGate;
        if (holdWarmClass) await warmGate;
        if (failClass) return route.fulfill({ status: 503, body: 'Busy' });
        return route.fulfill({ contentType: 'text/html', body: tasks });
      }
      return route.fulfill({ contentType: 'text/html', body: shell('<h1>Workspace</h1>') });
    });
    browser.setDefaultTimeout(7000);
    const tab = await browser.newPage();
    await tab.goto(host + '/student/dashboard');
    await tab.getByRole('link', { name: 'Overall Grades' }).click();
    await tab.getByText('Finding your classes…', { exact: true }).waitFor();
    const progress = tab.getByRole('progressbar', { name: 'Grade synchronization' });
    assert.equal(await progress.getAttribute('aria-valuenow'), null);
    await tab.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await tab.locator('.mbgc-loading-ring').evaluate((node) => getComputedStyle(node, '::after').animationName), 'none');
    resumeRoster();
    await tab.getByText('Collecting assessments for 1 class found so far…', { exact: true }).waitFor();
    resumeClass();
    await tab.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    assert.equal(await tab.locator('.mbgc-loading').count(), 0);
    failClass = false;
    await browser.serviceWorkers()[0].evaluate(() => chrome.storage.session.remove('mbgc:cache:uia.managebac.com:28:refresh'));
    await tab.getByRole('button', { name: 'Retry', exact: true }).click();
    await tab.getByText('50.00%', { exact: true }).waitFor();
    await tab.getByRole('button', { name: 'Refresh now' }).waitFor();
    await tab.getByRole('button', { name: 'Back to ManageBac' }).click();
    await tab.reload();
    await tab.evaluate((html) => document.querySelector('.sidebar nav').insertAdjacentHTML('beforeend', html), classLink);
    const badge = tab.locator('.sidebar a[href="/student/classes/123"] > .mbgc-sidebar-grade');
    await tab.getByRole('img', { name: 'Calculated grade D' }).waitFor();
    await tab.getByRole('link', { name: 'Overall Grades' }).click();
    await tab.getByText('50.00%', { exact: true }).waitFor();
    assert.equal(await tab.locator('.mbgc-loading').count(), 0);
    await tab.getByLabel('Global calculation method', { exact: true }).selectOption('points');
    await tab.getByRole('img', { name: 'Calculated grade A' }).waitFor();
    await tab.getByText('82.73%', { exact: true }).waitFor();
    assert.equal(await badge.count(), 1);
    assert.equal(await badge.evaluate((node) => node.parentElement.scrollWidth <= node.closest('.sidebar').clientWidth), true);
    holdWarmClass = true;
    await browser.serviceWorkers()[0].evaluate(() => chrome.storage.session.remove('mbgc:cache:uia.managebac.com:28:refresh'));
    await tab.getByRole('button', { name: 'Refresh now' }).click();
    await tab.getByText('Updating grades…', { exact: true }).waitFor();
    assert.equal(await tab.getByText('82.73%', { exact: true }).isVisible(), true);
    assert.equal(await tab.locator('.mbgc-loading').count(), 0);
    resumeWarm();
    await tab.getByRole('button', { name: 'Refresh now' }).waitFor();
  } finally {
    resumeRoster();
    resumeClass();
    resumeWarm();
    await browser.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test('assessment search, appearance and welcome work together', { timeout: 38000 }, async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mbgc-expansion-'));
  let context;
  let reads = 0;
  const taskHtml = (await fixture('class-tasks'))
    .replace('<div data-task-list="all" data-term-id="71" data-total-count="4">', `<div data-task-list="all" data-term-id="71" data-total-count="4">
      <article class="task-card" data-category="Coursework">
        <a href="${tasksPath}/501">Quadratics test</a></article>
      <article class="task-card" data-task-id="502">
        <span class="task-title">Research checkpoint</span></article>`);
  async function openBrowser() {
    const opened = await chromium.launchPersistentContext(profile, {
      ...(browserPath ? { executablePath: browserPath } : { channel: 'chromium' }), headless: true,
      args: ['--disable-extensions-except=' + root, '--load-extension=' + root], viewport: { width: 1180, height: 880 }
    });
    opened.setDefaultTimeout(8000);
    await opened.route(host + '/**', (intercepted) => {
      const request = intercepted.request();
      if (!request.isNavigationRequest()) reads++;
      const body = new URL(request.url()).pathname === tasksPath ? taskHtml :
        '<header><a href="/student/profile/9">Manage Your Profile</a></header><main>Workspace</main>';
      return intercepted.fulfill({ contentType: 'text/html', body });
    });
    return opened;
  }

  try {
    context = await openBrowser();
    let tab = await context.newPage();
    await tab.goto(host + tasksPath);
    await tab.getByRole('link', { name: 'Overall Grades' }).click();
    const welcome = 'Welcome to GradeLens';
    await tab.getByRole('region', { name: welcome }).waitFor();
    await tab.getByRole('button', { name: 'Skip guide' }).focus();
    await tab.keyboard.press('Escape');
    await tab.getByRole('region', { name: welcome }).waitFor({ state: 'detached' });
    await tab.getByRole('button', { name: 'Refresh now' }).waitFor();

    const subject = tab.locator('.mbgc-subject').filter({ hasText: '74.50%' });
    await subject.locator('summary').click();
    const search = subject.getByRole('searchbox');
    await search.fill('   QUADrAtics    test ');
    await subject.getByText('1 matching assessment.').waitFor();
    assert.equal(await subject.locator('.mbgc-assessment:visible').count(), 1);
    assert.equal(await subject.locator('.mbgc-subject-grade .mbgc-numeral').textContent(), '74.50%');
    await search.fill('courseWORK');
    await subject.getByText('3 matching assessments.').waitFor();
    await subject.getByText('65.00%', { exact: true }).waitFor();
    await search.fill('not visible in ManageBac');
    await subject.getByText(/No matches among the assessments shown/).waitFor();
    await subject.getByText(/could not confirm that the task list includes every assessment/).waitFor();
    await subject.getByRole('button', { name: 'Clear search' }).click();
    assert.equal(await search.inputValue(), '');
    const linked = subject.getByRole('link', { name: 'Quadratics test (opens in a new tab)' });
    await linked.focus();
    const popup = context.waitForEvent('page');
    await tab.keyboard.press('Enter');
    const task = await popup;
    await task.waitForURL(host + tasksPath + '/501');
    await task.close();
    assert.equal(await subject.getByRole('link', { name: /Research checkpoint/ }).count(), 0);

    await tab.locator('.mbgc-settings > summary').click();
    const priorReads = reads;
    const height = await subject.locator('summary').evaluate((node) => node.offsetHeight);
    await tab.getByLabel('Card density').selectOption('compact');
    await tab.locator('.mbgc-stage[data-density="compact"]').waitFor();
    assert.ok(await subject.locator('summary').evaluate((node) => node.offsetHeight) < height);
    await tab.getByLabel('Show grade progress bars').uncheck();
    await tab.locator('.mbgc-stage[data-progress-bars="false"]').waitFor();
    assert.equal(await subject.locator('.mbgc-row-method .mbgc-track').isVisible(), false);
    await tab.getByLabel('Animation intensity').selectOption('reduced');
    await tab.locator('.mbgc-stage[data-motion="reduced"]').waitFor();
    assert.equal(await subject.locator('summary').evaluate((node) => getComputedStyle(node.closest('.mbgc-subject')).transitionDuration), '0.07s');
    await tab.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await subject.locator('summary').evaluate((node) => getComputedStyle(node.closest('.mbgc-subject')).transitionDuration), '0s');
    await tab.getByLabel('Animation intensity').selectOption('off');
    await tab.locator('.mbgc-stage[data-motion="off"]').waitFor();
    assert.equal(reads, priorReads);

    await tab.getByRole('button', { name: 'Show welcome guide' }).click();
    await tab.getByRole('region', { name: welcome }).waitFor();
    await tab.waitForFunction(() => document.querySelector('#mbgc-stage-host').shadowRoot.activeElement?.id === 'mbgc-welcome-heading');
    await tab.getByRole('button', { name: 'Get started' }).click();
    await tab.getByRole('region', { name: welcome }).waitFor({ state: 'detached' });

    await context.close();
    context = await openBrowser();
    tab = await context.newPage();
    await tab.goto(host + tasksPath + '#mbgc-overall-grades');
    await tab.locator('.mbgc-stage[data-density="compact"][data-progress-bars="false"][data-motion="off"]').waitFor();
    assert.equal(await tab.getByRole('region', { name: welcome }).count(), 0);
    await context.serviceWorkers()[0].evaluate(() => chrome.storage.local.set({ 'mbgc:preferences': { method: 'absolute' } }));
    await tab.reload();
    await tab.getByLabel('Global calculation method', { exact: true }).waitFor();
    assert.equal(await tab.getByRole('region', { name: welcome }).count(), 0);
    const migrated = await context.serviceWorkers()[0].evaluate(async () =>
      (await chrome.storage.local.get('mbgc:preferences'))['mbgc:preferences']);
    assert.equal(migrated.welcomeSeen, true);
    assert.equal(migrated.method, 'absolute');
  } finally {
    await context?.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});

test('toolbar preferences, independent subject methods, all grade views and restart', { timeout: 55000 }, async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mbgc-methods-'));
  const tasks = await fixture('class-tasks');
  const overview = tasks.replace(/<section data-all-tasks>[\s\S]*?<\/section>/, '<section><h2>Latest Activity</h2></section>');
  const physics = tasks.replaceAll('/classes/123', '/classes/456')
    .replaceAll('Mathematics Higher Level, Statistics and Mathematical Investigation', 'Physics')
    .replace('8 / 10 pts', '9 / 10 pts');
  const menu = '<nav aria-label="Workspace"><ul><li class="active"><a aria-current="page" href="/student/tasks_and_deadlines" style="background:rgb(200,200,200)">Tasks &amp; Deadlines</a></li></ul></nav>';
  let context;
  async function launch() {
    context = await chromium.launchPersistentContext(profile, {
      ...(browserPath ? { executablePath: browserPath } : { channel: 'chromium' }), headless: true,
      args: ['--disable-extensions-except=' + root, '--load-extension=' + root]
    });
    context.setDefaultTimeout(10000);
    await context.route(host + '/**', (intercept) => {
      const { pathname } = new URL(intercept.request().url());
      const page = pathname === tasksPath ? tasks : pathname === physicsPath ? physics :
        pathname === '/student/classes/123' ? overview :
        pathname === '/student/settings/personalisation' ? '<main><h1>Personalisation</h1><div class="card">Theme</div></main>' : tasks;
      const body = page.replace('<li><a href="/student/tasks_and_deadlines">', '<li class="active"><a aria-current="page" style="background:rgb(200,200,200)" href="/student/tasks_and_deadlines">');
      return intercept.fulfill({ contentType: 'text/html', body: pathname === '/student/settings/personalisation' ? menu + body : body });
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    return new URL(worker.url()).origin === 'null' ? worker.url().split('/src/')[0] : new URL(worker.url()).origin;
  }
  try {
    let extension = await launch();
    assert.equal(await context.serviceWorkers()[0].evaluate(() => chrome.runtime.getManifest().action.default_popup), 'popup.html');
    let page = await context.newPage();
    await page.goto(host + tasksPath);
    await page.locator('.mbgc-compact .mbgc-numeral').getByText('74.50%', { exact: true }).waitFor();
    let popup = await context.newPage();
    await popup.goto(extension + '/popup.html');
    const mathName = /Mathematics Higher Level/;
    const math = popup.getByLabel(mathName);
    const phys = popup.getByLabel('Physics', { exact: true });
    await math.selectOption('points');
    await phys.selectOption('absolute');
    await page.locator('.mbgc-compact').getByText(/Points-Based Averaging/).waitFor();
    await page.locator('.mbgc-compact .mbgc-numeral').getByText('72.25%', { exact: true }).waitFor();
    if (process.env.MBGC_POPUP_SCREENSHOT) {
      await popup.setViewportSize({ width: 400, height: 575 });
      await popup.screenshot({ path: process.env.MBGC_POPUP_SCREENSHOT });
    }
    await popup.getByText('Visibility', { exact: true }).click();
    await popup.getByLabel('Class Tasks grade').uncheck();
    await page.locator('.mbgc-card-host').waitFor({ state: 'detached' });
    await popup.getByLabel('Class Tasks grade').check();
    await page.locator('.mbgc-card-host').waitFor();
    await popup.getByLabel('Grades beside class names').uncheck();
    await page.locator('.mbgc-sidebar-grade').first().waitFor({ state: 'detached' });
    await popup.getByLabel('Grades beside class names').check();
    await page.locator('aside a[href="/student/classes/123"] .mbgc-sidebar-grade').waitFor();
    assert.equal(await page.locator('aside a[href="/student/classes/123"] .mbgc-sidebar-grade').getAttribute('data-letter'), 'B');
    await popup.getByLabel('Grade Estimator sidebar entry').uncheck();
    await page.getByRole('link', { name: 'Grade Estimator' }).waitFor({ state: 'detached' });
    await popup.getByLabel('Grade Estimator sidebar entry').check();
    await popup.getByLabel('Overall Grades sidebar entry').uncheck();
    await page.getByRole('link', { name: 'Overall Grades' }).waitFor({ state: 'detached' });
    await popup.getByLabel('Overall Grades sidebar entry').check();

    await page.getByRole('link', { name: 'Overall Grades' }).click();
    const mathRow = page.locator('.mbgc-subject[data-class-id="123"]');
    const physRow = page.locator('.mbgc-subject[data-class-id="456"]');
    await mathRow.getByText('72.25%', { exact: true }).waitFor();
    await physRow.getByText('74.62%', { exact: true }).waitFor();
    await page.locator('[data-mbgc-view-active] .mbgc-nav[aria-current="page"]').getByText('Overall Grades').waitFor();
    assert.equal(await page.locator('aside a[href="/student/tasks_and_deadlines"]').evaluate((link) => getComputedStyle(link).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.goBack();
    await page.locator('.mbgc-stage').waitFor({ state: 'detached' });
    assert.equal(await page.locator('aside a[href="/student/tasks_and_deadlines"]').evaluate((link) => getComputedStyle(link).backgroundColor), 'rgb(200, 200, 200)');
    await page.goForward();
    await mathRow.waitFor();
    await page.locator('aside nav').evaluate((nav) => {
      const replacement = nav.cloneNode(true);
      for (const owned of replacement.querySelectorAll('.mbgc-owned')) owned.remove();
      nav.replaceWith(replacement);
    });
    await page.getByRole('link', { name: 'Overall Grades' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Overall Grades' }).count(), 1);
    await page.evaluate(() => document.documentElement.style.setProperty('--primary-color', '#b64911'));
    await page.waitForFunction(() => document.querySelector('#mbgc-stage-host')?.style.getPropertyValue('--mbgc-accent') === 'rgb(182 73 17)');

    await page.getByRole('link', { name: 'Grade Estimator' }).click();
    await page.locator('.mbgc-actual').getByText('72.25%', { exact: true }).waitFor();
    await page.getByLabel('Subject', { exact: true }).selectOption('456');
    await page.locator('.mbgc-actual').getByText('74.62%', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Subject calculation method').inputValue(), 'absolute');
    await page.getByLabel('Subject calculation method').selectOption('');
    await page.locator('.mbgc-actual').getByText('76.00%', { exact: true }).waitFor();
    await popup.getByLabel('Global default', { exact: true }).selectOption('absolute');
    await page.locator('.mbgc-actual').getByText('74.62%', { exact: true }).waitFor();
    assert.equal(await popup.getByLabel(mathName).inputValue(), 'points');
    await popup.getByLabel('Global default', { exact: true }).selectOption('percentage');
    await page.locator('.mbgc-actual').getByText('76.00%', { exact: true }).waitFor();
    await popup.getByLabel('Physics', { exact: true }).selectOption('absolute');
    await page.locator('.mbgc-actual').getByText('74.62%', { exact: true }).waitFor();

    const other = await context.newPage();
    await other.goto(host + '/student/classes/123');
    await other.locator('.mbgc-compact .mbgc-numeral').getByText('72.25%', { exact: true }).waitFor();
    await popup.getByLabel('Class Overview grade').uncheck();
    await other.locator('.mbgc-card-host').waitFor({ state: 'detached' });
    await popup.getByLabel('Class Overview grade').check();
    await other.locator('.mbgc-card-host').waitFor();
    await other.goto(host + '/student/settings/personalisation');
    const appearance = other.locator('.mbgc-personalisation').getByLabel('Appearance');
    await appearance.selectOption('dark');
    await page.locator('html[data-mbgc-native-dark]').waitFor();
    assert.equal(await popup.getByLabel('Color mode').inputValue(), 'dark');
    await popup.getByRole('switch', { name: 'Enabled', exact: true }).uncheck();
    await page.locator('#mbgc-stage-host').waitFor({ state: 'detached' });
    await other.locator('.mbgc-personalisation').waitFor({ state: 'detached' });
    assert.equal(await other.locator('html').getAttribute('data-mbgc-native-dark'), null);
    await popup.getByRole('switch', { name: 'Enabled', exact: true }).check();
    await other.locator('.mbgc-personalisation').waitFor();
    await appearance.selectOption('light');
    await other.locator('html[data-mbgc-native-dark]').waitFor({ state: 'detached' });
    await other.close();
    await context.close();

    extension = await launch();
    page = await context.newPage();
    await page.goto(host + tasksPath);
    await page.locator('.mbgc-compact .mbgc-numeral').getByText('72.25%', { exact: true }).waitFor();
    popup = await context.newPage();
    await popup.goto(extension + '/popup.html');
    await popup.getByLabel(mathName).waitFor();
    assert.equal(await popup.getByLabel(mathName).inputValue(), 'points');
    assert.equal(await popup.getByLabel('Physics', { exact: true }).inputValue(), 'absolute');
    await popup.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.mbgc-settings[open]').waitFor();
  } finally {
    await context?.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});

test('GradeLens visual layout, outline navigation icons, browser zoom and accent themes', { timeout: 30000 }, async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mbgc-visual-'));
  const context = await chromium.launchPersistentContext(profile, {
    ...(browserPath ? { executablePath: browserPath } : { channel: 'chromium' }), headless: true,
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root], viewport: { width: 1240, height: 850 }
  });
  context.setDefaultTimeout(6000);
  try {
    const tasks = (await fixture('class-tasks')).replace('<ul>', `<ul>
      <li><a href="/student">My Workspace</a></li>
      <li><a href="/student/calendar">Calendar</a></li>
      <li><a href="/student/timetables">Timetables</a></li>
      <li><a href="/student/calendar/native"><svg data-native-icon viewBox="0 0 24 24"><path d="M1 1h4"/></svg>Calendar</a></li>`)
      .replace('</head>', '<style>aside a svg, aside a svg * { fill: red; stroke: none; } aside a svg { width: 32px; }</style></head>');
    const physics = tasks.replaceAll('/classes/123', '/classes/456')
      .replaceAll('Mathematics Higher Level, Statistics and Mathematical Investigation', 'Physics');
    await context.route(host + '/**', (route) => route.fulfill({ contentType: 'text/html',
      body: new URL(route.request().url()).pathname === physicsPath ? physics : tasks }));
    const page = await context.newPage();
    await page.goto(host + tasksPath);
    const icons = { workspace: 'rect', calendar: 'rect', timetable: 'circle', tasks: 'path', grades: 'line', estimator: 'line' };
    for (const [name, shape] of Object.entries(icons)) {
      const icon = page.locator('aside svg[data-mbgc-icon="' + name + '"]');
      await icon.waitFor();
      assert.equal(await icon.count(), 1);
      const visual = await icon.locator(shape).first().evaluate((node) => {
        const styles = getComputedStyle(node);
        return { fill: styles.fill, stroke: styles.stroke, width: node.ownerSVGElement.getBoundingClientRect().width };
      });
      assert.equal(visual.fill, 'none');
      assert.notEqual(visual.stroke, 'none');
      assert.equal(visual.width, 18);
    }
    assert.equal(await page.locator('a:has([data-native-icon]) .mbgc-glyph').count(), 0);
    await page.locator('a:has([data-native-icon])').evaluate((link) => link.closest('li').remove());
    await page.addStyleTag({ content: 'aside a { font-size: 0; }' });
    for (const name of Object.keys(icons)) assert.equal(
      (await page.locator('aside svg[data-mbgc-icon="' + name + '"]').boundingBox())?.width, 18);
    await page.evaluate(() => [...document.querySelectorAll('style')].find((style) => style.textContent === 'aside a { font-size: 0; }')?.remove());
    await page.getByRole('link', { name: 'Overall Grades' }).click();
    await page.locator('.mbgc-subject').first().waitFor();
    await page.waitForFunction(() => document.querySelector('#mbgc-stage-host')?.shadowRoot?.querySelector('.mbgc-wordmark-icon')?.naturalWidth === 48);
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    for (const zoom of [0.8, 1, 1.25, 1.5]) {
      await worker.evaluate(async ({ path, zoom }) => {
        const tabs = await chrome.tabs.query({ url: 'https://uia.managebac.com/student/*' });
        const tab = tabs.find((item) => item.url.includes(path + '#mbgc-overall-grades'));
        await chrome.tabs.setZoom(tab.id, zoom);
        if (await chrome.tabs.getZoom(tab.id) !== zoom) throw new Error('Zoom was not applied');
      }, { path: tasksPath, zoom });
      assert.ok(await page.locator('.mbgc-page').evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
    }
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://uia.managebac.com/student/*' });
      await chrome.tabs.setZoom(tab.id, 1);
    });
    for (const [theme, accent] of Object.entries({ blue: '20 112 239', orange: '219 105 3', red: '217 45 33', plum: '93 52 96', teal: '2 133 125' })) {
      await page.evaluate((theme) => {
        document.documentElement.style.removeProperty('--primary-color');
        document.body.dataset.theme = theme;
      }, theme);
      await page.waitForFunction((accent) => document.querySelector('#mbgc-stage-host')?.style.getPropertyValue('--mbgc-accent') === 'rgb(' + accent + ')', accent);
    }
    await page.getByText('Last updated', { exact: false }).first().waitFor();
    await page.getByRole('button', { name: 'Skip guide' }).click();
    await page.getByRole('region', { name: 'Welcome to GradeLens' }).waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 390, height: 760 });
    await page.locator('.mbgc-subject summary').first().click();
    await page.locator('.mbgc-category-metrics').first().waitFor();
    assert.ok(await page.locator('.mbgc-page').evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
    if (process.env.MBGC_MOBILE_SCREENSHOT) await page.screenshot({ path: process.env.MBGC_MOBILE_SCREENSHOT, fullPage: true, animations: 'disabled' });
    await page.getByRole('link', { name: 'Grade Estimator' }).click();
    await page.locator('.mbgc-prediction-comparison').waitFor();
    assert.ok(await page.locator('.mbgc-page').evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
  } finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});

test('v1.22 shared appearance, exact accents and single clipped navigation treatment', { timeout: 42000 }, async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mbgc-schemes-'));
  const markup = await fixture('native-appearance');
  const tasks = await fixture('class-tasks');
  const physics = tasks.replaceAll('/classes/123', '/classes/456')
    .replaceAll('Mathematics Higher Level, Statistics and Mathematical Investigation', 'Physics');
  const screenshots = process.env.MBGC_THEME_SCREENSHOTS;
  const nativeTasks = '/student/tasks_and_deadlines';
  const personal = '/student/settings/personalisation';
  const dashboard = '/student/dashboard';
  const pages = {
    [dashboard]: '<h1>Dashboard</h1><div class="columns"><section class="widget"><header class="widget-header panel-heading">Today</header><div class="widget-body" style="background:#fff"><strong>Mathematics</strong><p class="text-muted">11:00 AM · Room 204</p></div></section><section class="panel"><header class="panel-heading">My classes</header><div class="panel-body"><a href="/student/classes/123">Mathematics</a></div></section></div>',
    [nativeTasks]: '<h1>Tasks &amp; Deadlines</h1><section class="panel"><h2 class="panel-heading">Upcoming tasks</h2><div class="panel-body bg-white" style="background:#fff"><input class="form-control" type="search" placeholder="Search tasks"><table class="table"><thead><tr><th>Assessment</th><th>Due</th></tr></thead><tbody><tr><td>Practice exercises</td><td>Friday</td></tr></tbody></table><p class="text-danger">Submission pending</p></div></section>',
    '/student/calendar': '<h1>Calendar</h1><section class="card"><div class="card-body"><table class="fc"><thead><tr><th class="fc-col-header-cell">Monday</th><th class="fc-col-header-cell">Tuesday</th></tr></thead><tbody><tr><td class="fc-daygrid-day fc-day-today"><a class="fc-event" href="/student/calendar">Physics tutorial</a></td><td class="fc-daygrid-day">Study period</td></tr></tbody></table></div></section>',
    [personal]: '<h1>Personalisation</h1><div class="panel"><div class="panel-heading">Preferences</div><div class="panel-body" style="background:#fff"><label>Display name <input type="text" class="form-control" value="Student"></label><button class="btn-primary">Save native preferences</button></div></div>'
  };
  let context, worker;
  async function launch() {
    context = await chromium.launchPersistentContext(profile, {
      ...(browserPath ? { executablePath: browserPath } : { channel: 'chromium' }), headless: true,
      args: ['--disable-extensions-except=' + root, '--load-extension=' + root], viewport: { width: 1200, height: 880 }
    });
    context.setDefaultTimeout(7000);
    await context.route(host + '/**', (route) => {
      const { pathname } = new URL(route.request().url());
      const body = pages[pathname] ? markup.replace('__CONTENT__', pages[pathname])
        .replace('class="nav-item" href="' + pathname, 'class="nav-item active" aria-current="page" href="' + pathname) : pathname === physicsPath ? physics : tasks;
      return route.fulfill({ contentType: 'text/html', body });
    });
    worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  }
  const exact = {
    orange: ['255, 250, 234', '219, 105, 3'], blue: ['239, 248, 255', '20, 112, 239'],
    teal: ['235, 247, 243', '2, 133, 125'], red: ['254, 243, 242', '217, 45, 33'],
    plum: ['249, 245, 249', '93, 52, 96']
  };
  const nativeDark = 'html[data-mbgc-native-dark]';
  const snap = async (page, name, locator) => {
    if (!screenshots) return;
    const file = path.join(screenshots, name + '.png');
    await (locator ?? page).screenshot({ path: file, animations: 'disabled' });
  };
  try {
    await launch();
    await worker.evaluate(() => chrome.storage.local.set({ 'mbgc:preferences': { refreshMinutes: 0, welcomeSeen: true } }));
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(host + personal);
    const appearance = page.locator('.mbgc-personalisation').getByLabel('Appearance');
    assert.deepEqual(await appearance.locator('option').allTextContents(), ['Follow System', 'Light', 'Dark']);
    await appearance.selectOption('system');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.locator(nativeDark).waitFor();
    await appearance.selectOption('light');
    await page.locator(nativeDark).waitFor({ state: 'detached' });
    assert.equal(await page.locator('main .panel-body').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
    await appearance.selectOption('dark');
    await page.locator(nativeDark).waitFor();
    await page.emulateMedia({ colorScheme: 'light' });
    const route = async (url, theme) => {
      await page.goto(host + url);
      await page.locator(nativeDark).waitFor();
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await page.waitForFunction((rgb) => document.documentElement.style.getPropertyValue('--mbgc-native-accent') === 'rgb(' + rgb.replaceAll(',', '') + ')', exact[theme][1]);
    };
    await route(dashboard, 'orange');
    assert.equal(await page.locator('.widget-body').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(29, 35, 44)');
    await snap(page, '01-orange-dark-dashboard');
    await route(nativeTasks, 'orange');
    assert.equal(await page.locator('.panel-body').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(29, 35, 44)');
    assert.equal(await page.locator('input[type=search]').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(25, 31, 40)');
    assert.equal(await page.locator('.text-danger').evaluate((node) => getComputedStyle(node).color), 'rgb(255, 168, 178)');
    await snap(page, '02-orange-dark-tasks');
    await route('/student/calendar', 'blue');
    assert.equal(await page.locator('.fc-event').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(34, 85, 129)');
    await snap(page, '03-blue-dark-calendar');
    await route(personal, 'teal');
    assert.equal(await appearance.inputValue(), 'dark');
    await snap(page, '04-teal-dark-personalisation');
    await route(physicsPath, 'plum');
    await page.locator('.mbgc-compact .mbgc-numeral').waitFor();
    await route(tasksPath, 'plum');
    await page.getByRole('link', { name: 'Overall Grades' }).click();
    const skip = page.getByRole('button', { name: 'Skip guide' });
    if (await skip.isVisible()) await skip.click();
    await page.locator('.mbgc-subject-grade .mbgc-numeral', { hasText: '%' }).first().waitFor();
    await snap(page, '05-plum-dark-grades');

    const base = worker.url().split('/src/')[0];
    const popup = await context.newPage();
    await popup.goto(base + '/popup.html');
    const popupAccent = (accent, mode) => popup.waitForFunction(([accent, mode]) =>
      document.documentElement.dataset.theme === mode &&
      document.documentElement.style.getPropertyValue('--mbgc-accent') === 'rgb(' + accent.replaceAll(',', '') + ')', [accent, mode]);
    await popupAccent(exact.plum[1], 'dark');
    await popup.getByText('Appearance', { exact: true }).click();
    await popup.getByLabel('Color mode').selectOption('light');
    await page.locator(nativeDark).waitFor({ state: 'detached' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'red'; });
    await popupAccent(exact.red[1], 'light');
    await page.getByRole('link', { name: 'Grade Estimator' }).click();
    await page.locator('.mbgc-prediction-comparison').waitFor();
    await snap(page, '06-red-light-estimator');
    // Native and extension routes each own one stripe, even with native pseudo-elements.
    await page.goto(host + nativeTasks);
    await page.locator('[data-mbgc-nav-native]').waitFor();
    await page.getByRole('link', { name: 'Overall Grades' }).click();
    for (const [theme, [highlight, accent]] of Object.entries(exact)) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      const active = page.locator('.mbgc-nav[aria-current="page"]');
      await page.waitForFunction((highlight) => getComputedStyle(document.querySelector('.mbgc-nav[aria-current="page"]')).backgroundColor ===
        'rgb(' + highlight + ')', highlight);
      const box = await active.evaluate((node) => {
        const style = getComputedStyle(node);
        return [style.borderInlineStartColor, style.borderInlineStartWidth, style.borderRadius, style.boxShadow,
          getComputedStyle(node, '::before').content, getComputedStyle(node, '::after').content,
          getComputedStyle(node.parentElement, '::before').content];
      });
      assert.deepEqual(box, ['rgb(' + accent + ')', '2px', '6px', 'none', 'none', 'none', 'none']);
      assert.equal(await active.count(), 1);
      assert.deepEqual(await page.locator('.sidebar a:not(.mbgc-nav[aria-current="page"])').evaluateAll((links) =>
        links.map((link) => getComputedStyle(link, '::before').content).filter((content) => content !== 'none')), []);
      assert.equal(await page.locator('[data-mbgc-nav-native]').count(), 0);
      await snap(page, 'sidebar-' + theme, page.locator('.sidebar'));
    }
    for (const zoom of [0.8, 1.25, 1.5, 1]) {
      await worker.evaluate(async ({ nativeTasks, zoom }) => {
        const tabs = await chrome.tabs.query({ url: 'https://uia.managebac.com/student/*' });
        const tab = tabs.find((tab) => tab.url.includes(nativeTasks + '#mbgc-overall-grades'));
        await chrome.tabs.setZoom(tab.id, zoom);
      }, { nativeTasks, zoom });
      const active = page.locator('.mbgc-nav[aria-current="page"]');
      assert.equal(await active.evaluate((node) => getComputedStyle(node).boxShadow), 'none');
      assert.equal(await active.evaluate((node) => node.getBoundingClientRect().right <=
        node.closest('.sidebar').getBoundingClientRect().right), true);
    }
    await page.goBack();
    await page.locator('[data-mbgc-nav-native]').waitFor();
    assert.equal(await page.locator('.mbgc-nav[aria-current="page"]').count(), 0);
    await page.goForward();
    await page.locator('.mbgc-nav[aria-current="page"]').waitFor();
    await popup.getByLabel('Color mode').selectOption('dark');
    await page.locator(nativeDark).waitFor();
    await context.close();
    await launch();
    const reopened = await context.newPage();
    await reopened.emulateMedia({ colorScheme: 'light' });
    await reopened.goto(host + personal);
    await reopened.locator(nativeDark).waitFor();
    assert.equal(await reopened.locator('.mbgc-personalisation').getByLabel('Appearance').inputValue(), 'dark');
  } finally {
    await context?.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});

test('v1.23 pairs native surfaces with legible text and aligns the six workspace links', { timeout: 40000 }, async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mbgc-native-surface-'));
  const context = await chromium.launchPersistentContext(profile, {
    ...(browserPath ? { executablePath: browserPath } : { channel: 'chromium' }), headless: true,
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root], viewport: { width: 1160, height: 800 }
  });
  context.setDefaultTimeout(7000);
  const directory = process.env.MBGC_V123_SCREENSHOTS;
  const base = await fixture('native-appearance');
  const taskHTML = await fixture('class-tasks');
  const classPath = '/student/classes/123';
  const groupPath = '/student/groups/22';
  const workspace = '/student/dashboard';
  const calendar = '/student/calendar';
  const timetable = '/student/timetables';
  const deadlines = '/student/tasks_and_deadlines';
  const personal = '/student/settings/personalisation';
  const banner = (noun) => `<header class="${noun.toLowerCase()}-banner-content" style="background:#fff">
      <div class="banner-artwork" style="height:48px;background-image:linear-gradient(120deg,#37608b,#26466a)"></div>
      <h1 style="color:#111">${noun === 'Class' ? 'Mathematics' : 'Student council'}</h1>
    </header>
    <nav aria-label="Record sections" role="tablist" class="nav-tabs">
      <a role="tab" aria-selected="true" href="#overview">Overview</a> <a role="tab" href="#members">Members</a>
    </nav>
    <section class="mystery-activity-container" style="background:#f8f8f9;padding:16px;margin-top:14px">
      <h2 style="color:#243142">Latest Activity</h2>
      <p style="color:#222">A new update is available.</p>
      <span class="badge" style="color:#fff;background:#3655b0">Published</span>
    </section>`;
  const pages = {
    [classPath]: banner('Class'), [groupPath]: banner('Group'),
    [workspace]: '<h1>My Workspace</h1><section class="workspace-welcome" style="background:#eee;padding:16px"><h2 style="color:#243142">Welcome back</h2><p>Upcoming classes and student tools.</p></section><div class="columns"><a class="dashboard-shortcut" style="background:#fff;padding:18px" href="/student/calendar">Calendar</a><a class="quick-launch" style="background:#fff;padding:18px" href="/student/tasks_and_deadlines">Tasks &amp; Deadlines</a></div>',
    [calendar]: '<h1>Calendar</h1><section class="card"><div class="card-body"><table class="fc"><thead><tr><th class="fc-col-header-cell">Monday</th></tr></thead><tbody><tr><td class="fc-daygrid-day fc-day-today">Physics</td></tr></tbody></table></div></section>',
    [timetable]: '<h1>Timetables</h1><section class="timetable panel"><table class="table"><thead><tr><th>Time</th><th>Class</th></tr></thead><tbody><tr><td>9:00</td><td>Physics</td></tr></tbody></table></section>',
    [deadlines]: '<h1>Tasks &amp; Deadlines</h1><div class="panel"><div class="panel-body" style="background:#fff"><label>Search <input class="form-control" type="search"></label><table class="table"><tbody><tr><td>Assignment</td></tr></tbody></table><p class="text-danger">Submission pending</p></div></div>',
    [personal]: '<h1>Personalisation</h1><section class="panel"><div class="panel-body"><label>Name <input class="form-control" type="text" value="Student"></label><button class="btn-primary">Save</button></div></section><div class="dropdown-menu" style="padding:10px"><a class="dropdown-item" href="#settings">Preferences menu</a></div><div class="modal-content" role="dialog" style="padding:10px;margin-top:8px"><h2>Preferences dialog</h2><p>Review settings.</p></div>'
  };
  const capture = async (page, name) => {
    if (directory) await page.screenshot({ path: path.join(directory, name + '.png'), animations: 'disabled', fullPage: true });
  };
  const contrast = async (locator) => locator.evaluate((node) => {
    const parse = (text) => text.match(/[\d.]+/g).map(Number);
    const light = (value) => parse(value).slice(0, 3).reduce((sum, c, index) => {
      const unit = c / 255;
      return sum + [.2126, .7152, .0722][index] * (unit <= .04045 ? unit / 12.92 : ((unit + .055) / 1.055) ** 2.4);
    }, 0);
    const fg = light(getComputedStyle(node).color);
    for (let parent = node; parent; parent = parent.parentElement ?? parent.getRootNode()?.host) {
      const bg = getComputedStyle(parent).backgroundColor;
      if ((parse(bg)[3] ?? 1) < .95) continue;
      const l = light(bg);
      return (Math.max(fg, l) + .05) / (Math.min(fg, l) + .05);
    }
    return 0;
  });
  try {
    await context.route(host + '/**', (intercept) => {
      const route = new URL(intercept.request().url()).pathname;
      const subjectTasks = route === physicsPath ? taskHTML.replaceAll('/classes/123', '/classes/456') : taskHTML;
      const html = pages[route] ? base.replace('>Dashboard</a>', '>My Workspace</a>').replace('__CONTENT__', pages[route])
        .replace('class="nav-item" href="' + route, 'class="nav-item active" aria-current="page" href="' + route) : subjectTasks;
      return intercept.fulfill({ body: html, contentType: 'text/html' });
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    await worker.evaluate(() => chrome.storage.local.set({ 'mbgc:preferences': { appearance: 'dark', refreshMinutes: 0, welcomeSeen: true } }));
    const page = await context.newPage();
    for (const [route, name] of [
      [workspace, '01-my-workspace'], [calendar, '02-calendar'], [timetable, '03-timetables'], [deadlines, '04-deadlines'],
      [classPath, '05-class-overview'], [tasksPath, '06-class-tasks'], [groupPath, '07-groups'], [personal, '08-personalisation']
    ]) {
      await page.goto(host + route);
      await page.locator('html[data-mbgc-native-dark]').waitFor();
      await page.locator('.mbgc-nav').first().waitFor();
      let sample = 'main h1';
      if ([groupPath, classPath].includes(route)) {
        await page.locator('.mystery-activity-container[data-mbgc-neutral-surface]').waitFor();
        assert.ok(await contrast(page.getByText('Latest Activity', { exact: true })) >= 4.5);
        assert.ok(await contrast(page.getByRole('tab', { name: 'Overview' })) >= 4.5);
        assert.equal(await page.locator('.banner-artwork').evaluate((node) => getComputedStyle(node).backgroundImage.startsWith('linear-gradient')), true);
        assert.equal(await page.locator('.badge').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(54, 85, 176)');
      }
      if (route === workspace) {
        await page.locator('.quick-launch[data-mbgc-neutral-surface]').waitFor();
        sample = '.workspace-welcome h2';
      }
      assert.ok(await contrast(page.locator(sample).first()) >= 4.5, name);
      for (const target of await page.locator('main td,main th,main label,main .btn-primary,main .dropdown-item,main [role="dialog"] p').all()) {
        assert.ok(await contrast(target) >= 4.5, name + ' ' + await target.textContent());
      }
      const selected = page.locator('[data-mbgc-nav-native]');
      if ([workspace, calendar, timetable, deadlines].includes(route)) {
        assert.equal(await selected.evaluate((node) => getComputedStyle(node).fontWeight), '700');
        const metrics = await page.locator('a[data-mbgc-nav-row]').evaluateAll((links) => links.map((link) => {
          const icon = link.querySelector('svg,i,img');
          const label = link.querySelector('.mbgc-nav-label');
          return [link.offsetHeight, icon.getBoundingClientRect().x, icon.getBoundingClientRect().width, label.getBoundingClientRect().x];
        }));
        assert.equal(metrics.length, 6);
        assert.ok(metrics.every((row) => JSON.stringify(row) === JSON.stringify(metrics[0])));
      }
      await capture(page, name);
    }
    await page.goto(host + tasksPath);
    await page.getByRole('link', { name: 'Overall Grades' }).click();
    await page.locator('.mbgc-subject-grade .mbgc-numeral', { hasText: '%' }).first().waitFor();
    assert.ok(await contrast(page.getByRole('heading', { name: 'Overall Grades' })) >= 4.5);
    assert.equal(await page.locator('.mbgc-nav[aria-current="page"]').evaluate((node) => getComputedStyle(node).fontWeight), '700');
    await capture(page, '09-overall-grades');
    await page.getByRole('link', { name: 'Grade Estimator' }).click();
    await page.locator('.mbgc-prediction-comparison').waitFor();
    assert.equal(await page.locator('.mbgc-nav[aria-current="page"]').evaluate((node) => getComputedStyle(node).fontWeight), '700');
    await capture(page, '10-grade-estimator');
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 400, height: 560 });
    await popup.goto(worker.url().split('/src/')[0] + '/popup.html');
    await popup.locator('html[data-theme="dark"]').waitFor();
    assert.ok(await contrast(popup.getByRole('heading', { name: 'GradeLens' })) >= 4.5);
    await capture(popup, '11-toolbar-popup');
    await page.goto(host + groupPath);
    await page.locator('.mystery-activity-container[data-mbgc-neutral-surface]').waitFor();
    await page.evaluate(() => {
      const panel = document.createElement('section');
      panel.className = 'new-neutral-panel';
      panel.style = 'background:rgb(249,249,250);height:65px';
      document.querySelector('main').append(panel);
    });
    await page.locator('.new-neutral-panel[data-mbgc-neutral-surface]').waitFor();
    await popup.getByText('Appearance', { exact: true }).click();
    await popup.getByLabel('Color mode').selectOption('light');
    await page.locator('html[data-mbgc-native-dark]').waitFor({ state: 'detached' });
    await page.locator('.new-neutral-panel[data-mbgc-neutral-surface]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.new-neutral-panel').evaluate((node) => getComputedStyle(node).backgroundColor),
      'rgb(249, 249, 250)');
    await page.locator('.mbgc-nav[data-theme="light"]').first().waitFor();
    assert.ok(await contrast(page.getByText('Latest Activity', { exact: true })) >= 4.5);
    await capture(page, '12-groups-light-restored');
  } finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
