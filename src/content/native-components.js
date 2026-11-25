// Bind native component styles to semantic regions, including flyouts rendered outside main.
(() => {
  const app = globalThis.MBGC;
  const root = document.documentElement;
  const page = 'data-mbgc-audit-page';
  const part = 'data-mbgc-audit-part';
  const tone = 'data-mbgc-audit-tone';
  const classesMenu = 'data-mbgc-audit-classes';
  const selectedLink = 'data-mbgc-audit-selected';
  const attrs = [page, part, tone, classesMenu, selectedLink];
  const owned = '.mbgc-owned,.mbr-ui,[data-banner-artwork],.banner-artwork';
  const headings = 'h1,h2,h3,[role="heading"],.page-title,.menu-title,.dropdown-header';
  const mainSelector = 'main,[role="main"],#main-content,#content,.main-content';
  const menus = 'nav,aside,[role="navigation"],[role="menu"],.sidebar,.dropdown-menu,[data-sidebar],.sidebar-flyout,.navigation-flyout,.sidebar-menu,.flyout,.main-sidebar,.navigation-rail,.side-navigation,[data-navigation-rail]';
  const scheduleSelector = menus + ',' + headings + ',table,[role="table"],[role="grid"],[role="row"],' +
    '.fc,.lesson-card,.timetable-card,.calendar-event,.group-card,.group-row,section,article,a,button';
  const tagged = new Set();
  let timer;
  let route;
  let anchor;
  let themeWasOn = false;

  function mark(node, attr, value) {
    if (!node || node.closest(owned)) return;
    if (node.getAttribute(attr) !== value) node.setAttribute(attr, value);
    tagged.add(node);
  }

  function clear() {
    for (const node of tagged) for (const attr of attrs) node.removeAttribute(attr);
    tagged.clear();
  }

  function identifyPage(main) {
    const titles = [...main.querySelectorAll(headings)].slice(0, 36).map((node) => app.clean(node.textContent));
    const title = (pattern) => titles.some((label) => pattern.test(label));
    const pathname = location.pathname;
    if (title(/^Notification Preferences$/i) || /\/(?:notification_preferences|notification_settings)(?:\/|$)/i.test(pathname)) return 'notifications';
    if (title(/^Timetables?(?: Overview)?$/i) || /\/(?:timetable|timetables)(?:\/|$)/i.test(pathname)) return 'timetable';
    if (title(/^Calendar$/i) || /\/calendar(?:\/|$)/i.test(pathname) || main.querySelector('.fc,.fullcalendar')) return 'calendar';
    if (title(/^(?:My Groups|Browse All Groups|Groups)(?:\s*\(\d+\))?$/i) || /\/student\/groups\/?$/i.test(pathname)) return 'groups';
    if (title(/^Personali[sz]ation$/i)) return 'personalisation';
    if (app.route(new URL(location.href)).type === 'overview') return 'overview';
    return '';
  }

  function toneFor(node) {
    // Read the site's fill with our tone marker removed so repeated audits are stable.
    node.removeAttribute(tone);
    const bg = getComputedStyle(node).backgroundColor;
    const match = bg.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    if (!match) return null;
    const rgb = match.slice(1).map(Number);
    const luma = rgb.reduce((sum, value, i) => {
      const unit = value / 255;
      return sum + [.2126, .7152, .0722][i] * (unit <= .04045 ? unit / 12.92 : ((unit + .055) / 1.055) ** 2.4);
    }, 0);
    if (Math.min(...rgb) >= 210 && Math.max(...rgb) - Math.min(...rgb) <= 16) return 'neutral';
    return luma >= Math.sqrt(.0525) - .05 ? 'light' : 'dark';
  }

  function inspectSchedule(main, kind) {
    const known = kind === 'timetable'
      ? '.lesson-card,.timetable-card,.lesson,.timetable-lesson,[data-lesson-id],[data-lesson-color]'
      : '.fc-event,.calendar-event,.event-card,[data-event-id],[data-event-color]';
    const candidates = main.querySelectorAll(known +
      (kind === 'timetable' ? ',td :is(a,div[class],div[style],article),[role="gridcell"] :is(a,div[class],div[style],article)' : ''));
    for (const node of [...candidates].slice(0, 350)) {
      if (!app.clean(node.textContent) || node.closest(owned) ||
          node.matches('.badge,.status,.event-count') ||
          (!node.matches(known) && node.querySelector(known))) continue;
      mark(node, part, kind === 'timetable' ? 'lesson' : 'event');
      const paint = toneFor(node);
      if (!paint) continue;
      mark(node, tone, paint);
    }
  }

  function inspectMenus(main) {
    const candidates = new Set(document.querySelectorAll(menus));
    if (anchor?.isConnected) {
      const menu = anchor.closest(menus);
      if (menu) candidates.add(menu);
    }
    // Some native flyouts use plain portal wrappers rather than navigation roles.
    for (const heading of [...document.querySelectorAll(headings)].slice(0, 180)) {
      if (main.contains(heading) || !/^(?:My Workspace|Classes|Groups)$/i.test(app.clean(heading.textContent))) continue;
      let container = heading.parentElement;
      for (let depth = 0; container && depth < 3 && !container.contains(main); depth++, container = container.parentElement) {
        if (container.querySelectorAll('a[href]').length < 2) continue;
        candidates.add(container);
        break;
      }
    }
    for (const menu of [...candidates].slice(0, 100)) {
      if (menu === main || menu.contains(main) || menu.closest(owned)) continue;
      const links = [...menu.querySelectorAll('a[href]')].slice(0, 35);
      const declared = app.clean(menu.getAttribute('aria-label'));
      const header = [...menu.querySelectorAll(headings + ',strong')].slice(0, 8)
        .find((node) => /^(?:My Workspace|Classes|Groups)$/i.test(app.clean(node.textContent)));
      const label = app.clean(header?.textContent || declared);
      const workspace = /^(?:My Workspace|Workspace)$/i.test(label) || (anchor?.isConnected && menu.contains(anchor));
      const classes = /^Classes$/i.test(label) && links.some((link) => /\/student\/classes/.test(link.getAttribute('href')));
      const groups = /^Groups$/i.test(label) && links.some((link) => /\/student\/(?:groups|ib-groups)/.test(link.getAttribute('href')));
      const account = links.some((link) => /^(?:Manage Your Profile|Notification Preferences|Personali[sz]ation)$/i.test(app.clean(link.textContent)));
      const rail = menu.matches('.main-sidebar,.navigation-rail,.side-navigation,[data-navigation-rail],.sidebar,[data-sidebar]') ||
        (!main.contains(menu) && menu.matches('nav,aside,[role="navigation"]') &&
          links.filter((link) => /^\/student(?:\/|$)/.test(app.localURL(link.getAttribute('href'), location.href)?.pathname ?? '') &&
            link.querySelector('svg,i,[data-icon]') && !app.clean(link.textContent)).length >= 3);
      if (!(workspace || classes || groups || account || rail)) continue;
      if (main?.contains(menu) && !menu.matches('aside,.sidebar,[role="menu"],.dropdown-menu,.flyout,.sidebar-flyout,.sidebar-menu') && !workspace) continue;
      mark(menu, part, 'menu');
      if (header && !header.closest('a,button')) mark(header, part, 'menu-title');
      if (classes) {
        mark(menu, classesMenu, '');
        const id = app.route(new URL(location.href)).classId;
        let selected = false;
        for (const link of links) {
          const url = app.localURL(link.getAttribute('href'), location.href);
          const matches = !selected && id && url && app.route(url).classId === id;
          if (matches) { mark(link, selectedLink, ''); selected = true; }
          else link.removeAttribute(selectedLink);
        }
      }
    }
  }

  function inspect() {
    timer = undefined;
    const dark = root.hasAttribute('data-mbgc-native-dark');
    if (route !== location.pathname || !dark) {
      clear();
      route = location.pathname;
    }
    themeWasOn = dark;
    if (!dark) return;
    for (const node of tagged) if (!node.isConnected) tagged.delete(node);
    const main = document.querySelector(mainSelector);
    if (!main) return;
    const kind = identifyPage(main);
    if (kind) mark(main, page, kind);
    else main.removeAttribute(page);
    if (kind === 'timetable' || kind === 'calendar') inspectSchedule(main, kind);
    if (kind === 'notifications') {
      for (const table of [...main.querySelectorAll('table,[role="table"],[role="grid"],.notification-settings')].slice(0, 12)) {
        if (table.querySelector('input[type="checkbox"],[role="checkbox"]')) mark(table, part, 'notification-table');
      }
    }
    if (kind === 'groups') {
      for (const link of [...main.querySelectorAll('a[href*="/student/groups/"],a[href*="/student/ib-groups/"]')].slice(0, 180)) {
        const row = link.closest('article,li,[role="listitem"],[data-group-id],.group-row,.group-card,.group-list-item');
        if (row && main.contains(row) && !row.closest('nav,[role="tablist"]')) mark(row, part, 'group-row');
      }
    }
    if (kind === 'overview') {
      for (const button of [...main.querySelectorAll('a,button,[role="button"]')].slice(0, 180)) {
        if (/^Show More$/i.test(app.clean(button.textContent))) mark(button, part, 'activity-more');
      }
    }
    inspectMenus(main);
  }

  function queue() {
    if (timer === undefined) timer = setTimeout(inspect, 65);
  }
  app.bindNativeComponents = (nativeAnchor) => {
    const changed = anchor !== nativeAnchor;
    anchor = nativeAnchor;
    if (changed || route !== location.pathname || themeWasOn !== root.hasAttribute('data-mbgc-native-dark')) queue();
  };
  app.observeNativeComponents = (records) => {
    if (!root.hasAttribute('data-mbgc-native-dark') || timer !== undefined) return;
    if (records.some(({ type, target, addedNodes, attributeName }) => {
      if (target.nodeType !== Node.ELEMENT_NODE || target.closest(owned)) return false;
      if (type === 'attributes') {
        if (!['class', 'style', 'hidden', 'aria-hidden', 'aria-expanded', 'href'].includes(attributeName)) return false;
        return target.matches(menus) || target.closest('[' + page + '],[' + part + '="menu"]');
      }
      return [...addedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE && !node.closest(owned) &&
        (node.matches(scheduleSelector) || node.querySelector(scheduleSelector)));
    })) queue();
  };
  new MutationObserver(queue).observe(root, { attributes: true, attributeFilter: ['data-mbgc-native-dark'] });
  queue();
})();
