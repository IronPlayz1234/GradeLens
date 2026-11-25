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
  return (expression) => protocol.send('Runtime.evaluate', { contextId: isolated.id, expression });
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
    await waitText('.mbgc-compact .mbgc-numeral', '—');
    await page.evaluate(() => {
      const list = document.querySelector('[data-task-list]');
      list.dataset.termId = '72';
      list.querySelector('.points').textContent = '0 / 10 pts';
    });
    await waitText('.mbgc-compact .mbgc-numeral', '53.85%');
    assert.equal(await page.locator('.mbgc-card-host').count(), 1);

    // Bypass the network cooldown in the fixture, then verify a manual refresh reads the second class.
    physics = physics.replace('9 / 10 pts', '10 / 10 pts');
    await worker.evaluate(async () => {
      await chrome.storage.session.remove('mbgc:cache:uia.managebac.com:9:refresh');
    });
    await page.getByRole('link', { name: 'Overall Grades' }).click();
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
    await second.waitForFunction(() => document.querySelector('.mbgc-compact .mbgc-numeral')?.textContent === '—');
    const stored = await worker.evaluate(() => chrome.storage.session.get('mbgc:cache:uia.managebac.com:9'));
    assert.ok(stored['mbgc:cache:uia.managebac.com:9']);
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
    await page.getByText('Sync diagnostics', { exact: true }).click();
    await page.getByText(/3 assessments read of 3 candidates · 2 with usable points/).waitFor();
    await page.getByRole('link', { name: 'Grade Estimator' }).click();
    await page.locator('.mbgc-actual .mbgc-numeral', { hasText: '54.00%' }).waitFor();
    assert.equal(await page.getByLabel('Academic term').inputValue(), 'term:671');
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
    assert.equal(await page.getByLabel('Academic term').inputValue(), 'term:672');
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
    await page.evaluate(() => { document.querySelector('.score-points').textContent = '19 / 20'; });
    await page.locator('.mbgc-compact .mbgc-numeral', { hasText: '57.00%' }).waitFor();
    await page.locator('.mbgc-compact').getByText(/Session cache unavailable/).waitFor();
    await evaluateExtension('chrome.runtime.sendMessage = globalThis.originalSend');
    await page.getByRole('link', { name: 'Overall Grades' }).click();
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await page.getByText('Sync diagnostics', { exact: true }).click();
    await page.getByText('Verified student session cache', { exact: true }).waitFor();

    useLettersOnly = true;
    await page.goto(host + tasksPath);
    await page.locator('.mbgc-compact').getByText(/letter grades alone cannot produce a percentage/i).waitFor();
    await page.getByRole('link', { name: 'Overall Grades' }).click();
    await page.getByText(/letter grades alone cannot produce a percentage/i).waitFor();
    await page.getByText('Sync diagnostics', { exact: true }).click();
    await page.getByText(/current document only · student identity/i).waitFor();
  } finally {
    await context.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});
