(() => {
  const app = globalThis.MBGC;
  const views = { '#mbgc-overall-grades': 'grades', '#mbgc-grade-estimator': 'estimator' };
  const stage = app.h('div', 'mbgc-owned mbgc-stage');
  const stageHost = app.h('div', 'mbgc-owned');
  stageHost.id = 'mbgc-stage-host';
  stageHost.append(stage);

  async function isolateDashboard() {
    try {
      const response = await fetch(chrome.runtime.getURL('src/ui/styles.css'));
      if (!response.ok) return;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(await response.text());
      const shadow = stageHost.attachShadow({ mode: 'open' });
      shadow.adoptedStyleSheets = [sheet];
      shadow.append(stage);
    } catch {
      // Chrome can invalidate an existing content script during extension reload.
    }
  }
  const card = app.h('div', 'mbgc-owned mbgc-card-host');
  let nav = [];
  let fallback;
  let nativeHost;
  let nativeAnchor;
  let theme;
  let themeKey = '';
  let cardKey = '';
  let cardSection;
  let viewKey = '';
  let lastURL = location.href;
  let lastAccount;
  let view = freshView();
  let scanTimer;
  let renderTimer;
  let lastGrades = new Map();
  let changed = new Map();
  let wasViewing = false;
  let lastRenderedMethod;
  let gradeRevision = '';
  let renderedView;
  let fullScan = false;
  let dirtyRows = new Set();
  let scanQueuedAt = 0;
  const sync = new app.Sync(scheduleRender);

  function freshView() {
    return { expanded: new Set(), changed: new Map(), nextId: 0 };
  }

  const mainSelector = 'main,[role="main"],#main-content,#content,.main-content';
  function mainCandidates() {
    return [...document.querySelectorAll(mainSelector)].filter((node) =>
      !node.closest('nav,aside,.sidebar,[role="navigation"]') && (!nativeAnchor || !node.contains(nativeAnchor)));
  }

  function knownMain() {
    return mainCandidates()[0] ?? null;
  }

  function dashboardBounds() {
    const viewport = document.documentElement.clientWidth;
    const sidebar = nativeAnchor?.closest('aside,.sidebar') ?? nativeAnchor?.closest('[role="navigation"],nav');
    const rect = sidebar?.getBoundingClientRect();
    const side = rect && rect.left < viewport * .15 && rect.right < viewport * .45 && rect.height > rect.width
      ? Math.max(0, rect.right) : 0;
    const content = mainCandidates().find((node) => {
      const box = node.getBoundingClientRect();
      return box.width >= (viewport - side) * .70 && box.left >= side - 16 && box.right <= viewport + 4 &&
        getComputedStyle(node).display !== 'contents';
    });
    return { content, side };
  }

  function mountDashboard() {
    const { content, side } = dashboardBounds();
    if (nativeHost && nativeHost !== content) nativeHost.classList.remove('mbgc-native-view');
    nativeHost = content;
    stageHost.classList.toggle('mbgc-stage-fixed', !content);
    if (stageHost.style.getPropertyValue('--mbgc-content-start') !== side + 'px') {
      stageHost.style.setProperty('--mbgc-content-start', side + 'px');
    }
    if (content) {
      if (stageHost.parentNode !== content) content.prepend(stageHost);
      if (!content.classList.contains('mbgc-native-view')) content.classList.add('mbgc-native-view');
    } else if (stageHost.parentNode !== document.body) document.body.append(stageHost);
  }

  function unmountDashboard() {
    nativeHost?.classList.remove('mbgc-native-view');
    nativeHost = null;
    stageHost.remove();
  }

  function getWorkspaceAnchor() {
    return [...document.querySelectorAll('a[href]:not(.mbgc-nav)')].find((node) => {
      const url = app.localURL(node.getAttribute('href'), location.href);
      return url?.pathname.replace(/\/$/, '') === app.workspacePath &&
        (node.closest('aside, nav, [role="navigation"], .sidebar') ||
          /^tasks\s*(?:&|and)\s*deadlines$/i.test(app.clean(node.textContent))) &&
        !url.search;
    }) ?? null;
  }

  function openView(hash) {
    history.pushState(history.state, '', location.pathname + location.search + hash);
    reconcile();
  }
  function closeView() {
    history.pushState(history.state, '', location.pathname + location.search);
    reconcile();
    nav[0]?.focus({ preventScroll: true });
  }

  function navLink(text, hash, glyph) {
    const link = app.h('a', 'mbgc-owned mbgc-nav', app.icon(glyph), text);
    link.href = hash;
    link.addEventListener('click', (event) => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openView(hash);
    });
    return link;
  }

  function installNav() {
    const anchor = nativeAnchor?.isConnected ? nativeAnchor : getWorkspaceAnchor();
    if (nativeAnchor === anchor && nav.length && nav.every((item) => item.isConnected)) return;
    for (const item of nav) (item.closest('.mbgc-nav-shell') ?? item).remove();
    fallback?.remove();
    nativeAnchor = anchor;
    nav = [navLink('Overall Grades', '#mbgc-overall-grades', 'grades'),
      navLink('Grade Estimator', '#mbgc-grade-estimator', 'estimator')];
    if (anchor) {
      if (anchor.className && typeof anchor.className === 'string') nav.forEach((item) => {
        const nativeClasses = [...anchor.classList].filter((name) => !/active|selected|current/i.test(name));
        item.classList.add(...nativeClasses);
      });
      const listItem = anchor.closest('li');
      if (listItem?.parentElement?.matches('ul, ol')) {
        listItem.after(...nav.map((item) => app.h('li', 'mbgc-owned mbgc-nav-shell', item)));
      } else {
        anchor.after(...nav);
      }
    } else {
      const main = knownMain();
      if (main) {
        fallback = app.h('div', 'mbgc-owned mbgc-fallback-nav', nav);
        main.before(fallback);
      }
    }
    themeKey = '';
  }

  function updateClassBadges() {
    const scope = ':is(aside,nav,[role="navigation"],.sidebar)';
    for (const link of document.querySelectorAll(scope + ' a[href*="/student/classes/"], a:has(> .mbgc-sidebar-grade)')) {
      const badge = link.querySelector(':scope > .mbgc-sidebar-grade');
      const url = app.localURL(link.getAttribute('href'), location.href);
      const route = url && app.route(url);
      const enrolledLink = (route?.type === 'overview' || route?.type === 'tasks') && link.closest(scope) &&
        (!link.closest(mainSelector) || link.closest('aside,.sidebar'));
      const entry = enrolledLink && sync.cache.classes[route.classId];
      const nativeTerm = url && app.termFromURL(url)?.id;
      const term = nativeTerm ? 'term:' + nativeTerm :
        view.term && view.term !== app.currentTerms && view.term !== 'unknown' ? view.term : app.classTermKey(entry);
      const data = entry && app.gradeData(sync, route.classId, term);
      const letter = data && app.letter(data.result.percentage, data.scale);
      if (!letter) {
        badge?.remove();
        continue;
      }
      if (badge?.dataset.letter === letter) continue;
      const next = badge ?? app.h('span', 'mbgc-owned mbgc-sidebar-grade');
      next.dataset.letter = letter;
      next.setAttribute('role', 'img');
      next.setAttribute('aria-label', 'Calculated grade ' + letter);
      if (!badge) link.append(next);
    }
  }

  function placeCard(type) {
    if (type === 'tasks') {
      const { title, section, chart } = app.taskSurface(document);
      if (!title || !section) return false;
      if (!chart) return card.isConnected && (section.contains(card) ||
        Boolean(cardSection?.contains(title) && cardSection.contains(card)));
      cardSection = section;
      let chartPanel = chart;
      while (chartPanel.parentElement !== section) {
        const parent = chartPanel.parentElement;
        if (!parent || parent.contains(title) || parent.querySelector('select,[role="combobox"],[data-selected-term-id]')) break;
        chartPanel = parent;
      }
      if (chartPanel.previousElementSibling !== card) chartPanel.before(card);
      return card.isConnected;
    }
    const main = knownMain() ?? document;
    const heading = app.heading(document, /^latest activity$/i);
    if (heading) {
      const panel = heading.closest('section,article,.section,.panel,.card');
      const section = panel && !panel.querySelector('h1,.class-title,[data-class-title]') ? panel : heading;
      if (section.previousElementSibling !== card) section.before(card);
      return card.isConnected;
    }
    const title = document.querySelector('.class-title,[data-class-title]') ?? main.querySelector('h1');
    const header = title?.closest('header,[role="banner"]') ?? title;
    if (header && header.nextElementSibling !== card) header.after(card);
    else if (!header && main instanceof HTMLElement && main.lastElementChild !== card) main.append(card);
    return card.isConnected;
  }

  function selectClassTerm(classId) {
    const native = sync.context?.term.id;
    if (sync.context?.context.type === 'tasks' && !native) return 'unknown';
    return app.classTermKey(sync.cache.classes[classId], native);
  }

  function updateChanges() {
    for (const [key, expiry] of changed) if (Date.now() > expiry) changed.delete(key);
    const revision = sync.revision + ':' + sync.settings.method + ':' + JSON.stringify(sync.overrides.weights);
    if (revision === gradeRevision) return;
    gradeRevision = revision;
    const next = new Map();
    for (const [classId, entry] of Object.entries(sync.cache.classes)) {
      for (const term of Object.keys(entry.terms)) {
        const item = app.gradeData(sync, classId, term);
        if (item.result.percentage !== null) {
          next.set(classId + ':' + term, { value: item.result.percentage, method: sync.settings.method,
            assessment: JSON.stringify(item.tasks.map((task) => [task.id, task.earnedPoints, task.maxPoints, task.category])),
            weights: JSON.stringify(item.weights) });
        }
      }
    }
    let notify = false;
    for (const [key, item] of next) {
      const prior = lastGrades.get(key);
      if (prior && prior.method === item.method && prior.value !== item.value &&
        (item.assessment !== prior.assessment || item.weights !== prior.weights)) {
        changed.set(key, Date.now() + 9000);
        notify = true;
      }
    }
    if (notify) setTimeout(scheduleRender, 9200);
    lastGrades = next;
    view.changed = changed;
  }

  function focusReplacement(before, after) {
    const focused = stageHost.shadowRoot?.activeElement ?? document.activeElement;
    const focusable = 'button, select, input, textarea, summary, a[href]';
    if (!before.contains(focused)) return;
    const visible = (node) => (!node.closest('details:not([open])') || node.matches('summary')) && !node.closest('[hidden]');
    const old = [...before.querySelectorAll(focusable)].filter(visible);
    const position = old.indexOf(focused);
    const label = focused.closest('label')?.querySelector('.mbgc-field-label')?.textContent;
    const candidate = [...after.querySelectorAll(focusable)].filter(visible);
    const name = focused.getAttribute('aria-label');
    const replacement = name ? candidate.find((node) => node.getAttribute('aria-label') === name) : label ?
      candidate.find((node) => node.closest('label')?.querySelector('.mbgc-field-label')?.textContent === label) :
      candidate[position]?.tagName === focused.tagName ? candidate[position] : null;
    return replacement ?? null;
  }

  function render(force = false) {
    if (!app.studentPath(location.pathname)) {
      unmountDashboard();
      card.remove();
      for (const badge of document.querySelectorAll('.mbgc-sidebar-grade')) badge.remove();
      for (const item of nav) (item.closest('.mbgc-nav-shell') ?? item).remove();
      return;
    }
    if (lastAccount !== sync.account) {
      lastAccount = sync.account;
      lastGrades = new Map();
      changed = new Map();
      view = freshView();
      force = true;
    }
    installNav();
    for (const root of [stage, card]) {
      for (const key of ['density', 'motion', 'progressBars']) {
        const value = String(sync.settings[key]);
        if (root.dataset[key] !== value) root.dataset[key] = value;
      }
    }
    const nextTheme = app.getTheme(nativeAnchor);
    const nextThemeKey = JSON.stringify(nextTheme);
    if (nextThemeKey !== themeKey) {
      theme = nextTheme;
      themeKey = nextThemeKey;
      for (const node of [stage, stageHost, card, ...nav]) app.applyTheme(node, theme);
    }
    updateChanges();
    const panel = views[location.hash];
    nav.forEach((link) => {
      if (panel && link.hash === location.hash) {
        if (!link.hasAttribute('aria-current')) link.setAttribute('aria-current', 'page');
      } else if (link.hasAttribute('aria-current')) link.removeAttribute('aria-current');
    });
    const current = app.route(new URL(location.href));
    if (panel) {
      card.remove();
      mountDashboard();
      const contentKey = JSON.stringify([panel, sync.settings, sync.revision, sync.overrides, sync.refreshing, sync.refreshIssue,
        sync.message, sync.diagnostics, sync.storageState, sync.account, sync.identityStatus, [...changed]]);
      if (force || viewKey !== contentKey) {
        const editor = stageHost.shadowRoot?.activeElement ?? document.activeElement;
        if (!force && editor?.matches('textarea') && stage.contains(editor)) return;
        const handlers = {
          close: closeView, render: () => render(true),
          showWelcome: () => {
            view.welcomeOpen = true;
            render(true);
            stage.querySelector('#mbgc-welcome-heading')?.focus();
          },
          dismissWelcome: () => {
            const reopened = view.welcomeOpen;
            view.welcomeOpen = false;
            void sync.setSettings({ welcomeSeen: true });
            render(true);
            const target = reopened ? [...stage.querySelectorAll('button')].find((button) => button.textContent === 'Show welcome guide')
              : stage.querySelector('h1');
            if (target) {
              if (target.matches('h1')) target.tabIndex = -1;
              target.focus({ preventScroll: true });
            }
          }
        };
        const content = panel === 'grades' ? app.dashboard(sync, view, handlers) : app.estimator(sync, view, handlers);
        const focus = focusReplacement(stage, content);
        if (lastRenderedMethod && lastRenderedMethod !== sync.settings.method) {
          content.classList.add('mbgc-method-changed');
        }
        lastRenderedMethod = sync.settings.method;
        const patched = panel === 'grades' && renderedView === panel && app.patchDashboard(stage.firstElementChild, content);
        if (!patched) stage.replaceChildren(content);
        if (focus?.isConnected) focus.focus({ preventScroll: true });
        renderedView = panel;
        if (!wasViewing) {
          const heading = stage.querySelector('h1');
          heading.tabIndex = -1;
          heading.focus({ preventScroll: true });
        }
        viewKey = contentKey;
      }
      updateClassBadges();
      wasViewing = true;
    } else {
      updateClassBadges();
      unmountDashboard();
      viewKey = '';
      renderedView = null;
      wasViewing = false;
      if (!current.classId || !['tasks', 'overview'].includes(current.type)) {
        card.remove();
        return;
      }
      if (!placeCard(current.type)) { card.remove(); return; }
      const term = sync.context?.context.classId === current.classId && sync.context?.context.type === current.type
        ? selectClassTerm(current.classId) : 'unknown';
      const data = app.gradeData(sync, current.classId, term);
      const update = changed.has(current.classId + ':' + term);
      const nextCardKey = JSON.stringify([data, current.type, sync.settings.method, update, sync.diagnostics, sync.storageState]);
      if (cardKey !== nextCardKey || !card.firstChild) {
        card.replaceChildren(app.compact(sync, data, current.type, update));
        cardKey = nextCardKey;
      }
    }
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, 35);
  }
  function queueScan(rows = null) {
    if (rows === null) fullScan = true;
    else for (const row of rows) dirtyRows.add(row);
    clearTimeout(scanTimer);
    const now = performance.now();
    scanQueuedAt ||= now;
    scanTimer = setTimeout(() => {
      const candidates = fullScan ? null : dirtyRows;
      dirtyRows = new Set();
      fullScan = false;
      scanQueuedAt = 0;
      sync.scanVisible(candidates).then(() => {
        if (candidates === null) return sync.refresh();
      }).catch(() => {
        sync.message = 'This page could not be scanned. Cached grades are still available.';
        scheduleRender();
      });
    }, Math.min(230, Math.max(0, 900 - (now - scanQueuedAt))));
  }

  function reconcile() {
    const current = location.href;
    const previous = new URL(lastURL);
    const next = new URL(current);
    lastURL = current;
    if (previous.pathname !== next.pathname || previous.search !== next.search) {
      sync.stopRefresh();
      queueScan();
    } else if (previous.hash !== next.hash) {
      if (views[next.hash]) void sync.refresh();
      else if (!sync.manualRefresh) sync.stopRefresh();
    }
    render();
  }
  function owns(node) {
    return (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('.mbgc-owned');
  }

  const gradeRoots = [app.selectors.tasks, app.selectors.score, app.selectors.points, app.selectors.letter, app.selectors.rubric].join(',');
  const chartRoots = 'canvas,svg,[data-chart],.chart-frame,.highcharts-container';
  const relevant = [gradeRoots, app.selectors.termControls, app.selectors.weights, app.selectors.scale,
    app.discoveryLinks, app.accountLinks, 'a[href*="/core_tasks/"],a[href*="/tasks/"]', 'table,thead,h1,h2,h3,h4,[role="heading"],.h2,.h3,.h4,.title',
    '[data-task-list],[data-current-student-id],[data-current-user-id],[role="listbox"],[role="option"]'].join(',');
  const structure = relevant + ',main,[role="main"],#content,[data-all-tasks]';
  const scoreAttributes = new Set(['data-earned-points', 'data-max-points', 'data-letter-grade', 'data-graded', 'data-grade-eligible', 'data-counts-toward-grade']);

  function handleMutations(records) {
    if (location.href !== lastURL) { reconcile(); return; }
    const scores = new Set();
    for (const entry of records) {
      if (owns(entry.target)) continue;
      const target = entry.target.nodeType === Node.ELEMENT_NODE ? entry.target : entry.target.parentElement;
      if (!target) continue;
      const children = [...entry.addedNodes, ...entry.removedNodes];
      if (entry.type === 'childList' && children.every(owns)) continue;
      if (entry.type === 'attributes' && (target === document.body || target === document.documentElement ||
        target.matches('main,[role="main"],nav,aside')) &&
        /^(class|style|data-theme|data-bs-theme|data-color-scheme)$/.test(entry.attributeName)) {
        scheduleRender();
        continue;
      }
      const row = target.closest(app.selectors.tasks);
      if (row && (scoreAttributes.has(entry.attributeName) || (entry.type !== 'attributes' && target.closest(app.selectors.score + ',' + app.selectors.points) &&
        children.every((node) => node.nodeType === Node.TEXT_NODE)))) {
        scores.add(row);
        continue;
      }
      if (target.matches('head') || target.closest(chartRoots)) continue;
      if (entry.type === 'attributes' && /^(style|class)$/.test(entry.attributeName) &&
        !target.matches('.dropdown-toggle,li.active,li.selected') && !target.closest(app.selectors.termControls)) continue;
      if (target.closest(relevant) || children.some((node) => node.nodeType === Node.ELEMENT_NODE &&
        !owns(node) && (node.matches(structure) || node.querySelector(structure)))) {
        queueScan();
        return;
      }
    }
    if (scores.size) queueScan(scores);
  }

  const observer = new MutationObserver(handleMutations);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['data-selected-term-id', 'data-term-id', 'data-total-count', 'class', 'style', 'hidden', 'aria-hidden',
      'aria-busy', 'aria-controls', 'data-loading', 'selected', 'value', 'href', 'aria-current', 'aria-selected', 'aria-expanded', 'data-selected', 'data-semester-id', 'data-academic-term-id', 'data-term-label', 'data-value', 'data-earned-points', 'data-max-points', 'data-letter-grade', 'data-graded', 'data-grade-eligible', 'data-counts-toward-grade', 'data-assessment-type', 'data-current-student-id', 'data-current-user-id', 'data-theme', 'data-bs-theme', 'data-color-scheme'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-bs-theme', 'data-color-scheme'] });
  window.addEventListener('popstate', reconcile);
  window.addEventListener('hashchange', reconcile);
  window.navigation?.addEventListener('currententrychange', reconcile);
  document.addEventListener('change', (event) => {
    if (event.target.matches?.(app.selectors.termControls) && !owns(event.target)) queueScan();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && stage.querySelector('.mbgc-welcome')) {
      event.preventDefault();
      stage.querySelector('.mbgc-welcome-skip').click();
      return;
    }
    if (event.key === 'Escape' && !event.defaultPrevented && views[location.hash] && stageHost.classList.contains('mbgc-stage-fixed')) {
      event.preventDefault();
      closeView();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (!sync.manualRefresh) sync.stopRefresh();
      return;
    }
    if (!sync.context || location.href !== lastURL) queueScan();
    else void sync.refresh();
  });
  window.addEventListener('pagehide', () => sync.stopRefresh());
  app.scheme.addEventListener('change', scheduleRender);
  window.addEventListener('resize', scheduleRender);
  setInterval(() => {
    if (location.href !== lastURL) reconcile();
    if (!document.hidden && app.studentPath(location.pathname)) sync.refresh();
  }, 15000);
  void isolateDashboard().catch(() => {});
  sync.init().catch(() => {}).finally(() => {
    render();
    sync.scanVisible().then(() => sync.refresh()).catch(() => {
      sync.message = 'This page could not be scanned.';
      scheduleRender();
    });
  });
})();
