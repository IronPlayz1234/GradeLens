(() => {
  const app = globalThis.MBGC;
  const views = { '#mbgc-overall-grades': 'grades', '#mbgc-grade-estimator': 'estimator' };
  const stage = app.h('div', 'mbgc-owned mbgc-stage');
  const card = app.h('div', 'mbgc-owned mbgc-card-host');
  let nav = [];
  let fallback;
  let nativeHost;
  let nativeAnchor;
  let theme;
  let themeKey = '';
  let cardKey = '';
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
  const sync = new app.Sync(scheduleRender);

  function freshView() {
    return { expanded: new Set(), changed: new Map(), nextId: 0 };
  }

  function knownMain() {
    const candidates = [...document.querySelectorAll('main, [role="main"], #main-content, #content, .main-content')];
    return candidates.find((node) => !node.closest('nav, aside') && (!nativeAnchor || !node.contains(nativeAnchor))) ?? null;
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
    const anchor = getWorkspaceAnchor();
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

  function nativeHeading(pattern, root = document) {
    const selectors = 'h1,h2,h3,h4,h5,[role="heading"],.h2,.h3,.h4,.section-title,.panel-title,.card-title';
    const candidates = [...root.querySelectorAll(selectors)].filter((node) =>
      !node.closest('.mbgc-owned,[hidden],[aria-hidden="true"]') && pattern.test(app.clean(node.textContent)));
    return candidates.find((node) => !candidates.some((other) => other !== node && node.contains(other))) ?? null;
  }

  function placeCard(type) {
    const main = knownMain() ?? document;
    if (type === 'tasks') {
      const heading = nativeHeading(/^all tasks$/i, main);
      if (!heading) return false;
      const titleBar = heading.closest('.section-header,.panel-heading,.card-header,.box-header,.section-heading') ?? heading;
      const section = heading.closest('[data-all-tasks], #all-tasks, #all_tasks, .section, .panel, .card, section, article');
      const chart = section && nativeHeading(/^(overall task completion|grade distribution|assessment)$/i, section);
      // Anchor to the section heading outside the chart subtree so chart switches retain the card.
      if (section && titleBar.parentElement === section && titleBar.nextElementSibling !== card) titleBar.after(card);
      else if (section && section !== titleBar && section.contains(titleBar)) {
        let branch = titleBar;
        while (branch.parentElement !== section && branch.parentElement) branch = branch.parentElement;
        if (chart && branch.contains(chart)) {
          if (titleBar.nextElementSibling !== card) titleBar.after(card);
        } else if (branch.nextElementSibling !== card) branch.after(card);
      } else if (titleBar.nextElementSibling !== card) titleBar.after(card);
      return card.isConnected;
    }
    const heading = nativeHeading(/^latest activity$/i, main);
    if (heading) {
      const section = heading.closest('section,article,.section,.panel,.card') ?? heading;
      if (section.previousElementSibling !== card) section.before(card);
      return card.isConnected;
    }
    if (main instanceof HTMLElement && main.firstElementChild !== card) main.prepend(card);
    return card.isConnected;
  }

  function selectClassTerm(classId) {
    const current = sync.context?.term;
    if (current?.id) return 'term:' + current.id;
    if (sync.context?.context.type === 'tasks') return 'unknown';
    const subject = sync.cache.classes[classId];
    const preferred = subject?.selectedTerm ?? subject?.defaultTerm;
    if (preferred) return 'term:' + preferred.id;
    const options = Object.entries(subject?.terms ?? {}).filter(([key, bucket]) => key !== 'unknown' && bucket.lastScan);
    if (options.length === 1) return options[0][0];
    return 'unknown';
  }

  function updateChanges() {
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
    for (const [key, expiry] of changed) if (Date.now() > expiry) changed.delete(key);
    if (notify) setTimeout(scheduleRender, 9200);
    lastGrades = next;
    view.changed = changed;
  }

  function focusReplacement(before, after) {
    const focused = document.activeElement;
    const focusable = 'button, select, input, textarea, summary, a[href]';
    if (!before.contains(focused)) return;
    const visible = (node) => !node.closest('details:not([open])') || node.matches('summary');
    const old = [...before.querySelectorAll(focusable)].filter(visible);
    const position = old.indexOf(focused);
    const label = focused.closest('label')?.querySelector('.mbgc-field-label')?.textContent;
    const candidate = [...after.querySelectorAll(focusable)].filter(visible);
    const replacement = label ? candidate.find((node) => node.closest('label')?.querySelector('.mbgc-field-label')?.textContent === label) :
      candidate[position]?.tagName === focused.tagName ? candidate[position] : null;
    return replacement ?? null;
  }

  function render(force = false) {
    if (!app.studentPath(location.pathname)) {
      nativeHost?.classList.remove('mbgc-native-view');
      stage.remove();
      card.remove();
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
    const nextTheme = app.getTheme(nativeAnchor);
    const nextThemeKey = JSON.stringify(nextTheme);
    if (nextThemeKey !== themeKey) {
      theme = nextTheme;
      themeKey = nextThemeKey;
      for (const node of [stage, card, ...nav]) app.applyTheme(node, theme);
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
      const main = knownMain();
      const nextHost = main && (!nativeAnchor || !main.contains(nativeAnchor)) ? main : null;
      if (nativeHost !== nextHost) nativeHost?.classList.remove('mbgc-native-view');
      nativeHost = nextHost;
      if (nativeHost) {
        if (stage.parentNode !== nativeHost) nativeHost.prepend(stage);
        nativeHost.classList.add('mbgc-native-view');
      } else if (stage.parentNode !== document.body) document.body.prepend(stage);
      const contentKey = JSON.stringify([panel, sync.settings, sync.cache, sync.overrides, sync.refreshing, sync.message, [...changed]]);
      if (force || viewKey !== contentKey) {
        const editor = document.activeElement;
        if (!force && editor?.matches('textarea') && stage.contains(editor)) return;
        const handlers = { close: closeView, render: () => render(true) };
        const content = panel === 'grades' ? app.dashboard(sync, view, handlers) : app.estimator(sync, view, handlers);
        const focus = focusReplacement(stage, content);
        if (lastRenderedMethod && lastRenderedMethod !== sync.settings.method) {
          content.classList.add('mbgc-method-changed');
        }
        lastRenderedMethod = sync.settings.method;
        stage.replaceChildren(content);
        focus?.focus({ preventScroll: true });
        if (!wasViewing) {
          const heading = stage.querySelector('h1');
          heading.tabIndex = -1;
          heading.focus({ preventScroll: true });
        }
        viewKey = contentKey;
      }
      wasViewing = true;
    } else {
      nativeHost?.classList.remove('mbgc-native-view');
      nativeHost = null;
      if (stage.isConnected) stage.remove();
      viewKey = '';
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
      const nextCardKey = JSON.stringify([data, current.type, sync.settings.method, update]);
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
  function queueScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      sync.scanVisible().catch(() => {
        sync.message = 'This page could not be scanned. Cached grades are still available.';
        scheduleRender();
      });
    }, 280);
  }
  function reconcile() {
    const current = location.href;
    const previous = new URL(lastURL);
    const next = new URL(current);
    lastURL = current;
    render();
    if (previous.pathname !== next.pathname || previous.search !== next.search) {
      queueScan();
      if (['overview', 'tasks', 'workspace'].includes(app.route(next).type) &&
        Date.now() - sync.lastAttempt > 30000) sync.refresh();
    }
  }
  function owns(node) {
    return (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('.mbgc-owned');
  }
  const relevant = [app.selectors.tasks, app.selectors.term, app.selectors.weights, app.selectors.scale,
    'a[href*="/student/"]', 'h1,h2,h3,h4,[role="heading"]', '[data-task-list],[data-current-student-id]'].join(',');
  const structure = relevant + ',main,[role="main"],#content,[data-all-tasks]';
  function touchesPage(records) {
    for (const entry of records) {
      if (owns(entry.target)) continue;
      if (entry.type === 'attributes' && ['class', 'style', 'data-theme', 'data-bs-theme', 'data-color-scheme'].includes(entry.attributeName) &&
        !entry.target.closest('.short-assignment, select, [data-task-list]')) {
        if (entry.target === document.body || entry.target === document.documentElement ||
          entry.target.matches('main, [role="main"], nav, aside, a[aria-current="page"]')) scheduleRender();
        continue;
      }
      if (entry.type === 'childList' && [...entry.addedNodes, ...entry.removedNodes].every(owns)) continue;
      const target = entry.target.nodeType === Node.ELEMENT_NODE ? entry.target : entry.target.parentElement;
      if (target?.closest(relevant) && !target.matches('body')) return true;
      if ([...entry.addedNodes, ...entry.removedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE &&
        !owns(node) && (node.matches(structure) || node.querySelector(structure)))) return true;
    }
    return false;
  }

  const observer = new MutationObserver((records) => {
    if (touchesPage(records)) {
      if (location.href !== lastURL) reconcile();
      else scheduleRender();
      queueScan();
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['data-selected-term-id', 'data-term-id', 'data-total-count', 'class', 'style', 'hidden', 'aria-hidden',
      'aria-busy', 'data-loading', 'selected', 'value', 'href', 'aria-current', 'data-current-student-id', 'data-theme', 'data-bs-theme', 'data-color-scheme'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-bs-theme', 'data-color-scheme'] });
  window.addEventListener('popstate', reconcile);
  window.addEventListener('hashchange', reconcile);
  window.navigation?.addEventListener('currententrychange', reconcile);
  document.addEventListener('change', (event) => {
    if (event.target.matches?.(app.selectors.term) && !owns(event.target)) queueScan();
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    queueScan();
    sync.refresh();
  });
  app.scheme.addEventListener('change', scheduleRender);
  setInterval(() => {
    if (location.href !== lastURL) reconcile();
    if (!document.hidden && app.studentPath(location.pathname)) sync.refresh();
  }, 15000);
  sync.init().catch(() => {}).finally(() => {
    render();
    sync.scanVisible().then(() => sync.refresh()).catch(() => {
      sync.message = 'This page could not be scanned.';
      scheduleRender();
    });
  });
})();
