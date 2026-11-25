(() => {
  const app = globalThis.MBGC;
  const prefsKey = 'mbgc:preferences';
  const overrideKey = (account) => 'mbgc:overrides:' + location.host + ':' + account;
  const refreshable = /^\/student\/(?:classes\/\d+\/core_tasks|tasks_and_deadlines)\/?$/;

  async function request(type, account, options = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'mbgc:' + type, account, ...options });
    if (!response || response.error) throw new Error(response?.error || 'Extension storage unavailable.');
    return response.value;
  }

  async function fetchPage(source, signal) {
    const url = app.localURL(source, location.href);
    if (!url || !refreshable.test(url.pathname)) return null;
    const response = await fetch(url, {
      credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
      headers: { Accept: 'text/html' }
    });
    const final = app.localURL(response.url, url);
    if (!response.ok || !final || !refreshable.test(final.pathname) ||
      !response.headers.get('content-type')?.includes('text/html')) return null;
    const html = new DOMParser().parseFromString(await response.text(), 'text/html');
    return { html, url: final };
  }

  class Sync {
    account = undefined;
    cache = app.freshCache();
    settings = { ...app.settingsDefaults };
    overrides = { weights: {}, scale: null };
    refreshing = false;
    message = '';
    lastAttempt = 0;
    signature = '';
    cursor = 0;
    context = null;
    queue = Promise.resolve();

    constructor(update) {
      this.update = update;
      chrome.runtime.onMessage.addListener((message, sender) => {
        const account = this.account;
        if (sender.id !== chrome.runtime.id || message?.type !== 'mbgc:cache-updated' || !account || message.account !== account) return;
        request('get', account).then((cache) => {
          if (this.account === account) {
            this.cache = cache;
            this.update(true);
          }
        }).catch(() => {});
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[prefsKey]) {
          this.settings = { ...app.settingsDefaults, ...changes[prefsKey].newValue };
          this.update();
        }
        if (this.account && area === 'local' && changes[overrideKey(this.account)]) {
          this.overrides = changes[overrideKey(this.account)].newValue ?? { weights: {}, scale: null };
          this.update();
        }
      });
    }

    async init() {
      this.settings = { ...app.settingsDefaults, ...(await chrome.storage.local.get(prefsKey))[prefsKey] };
    }

    async identify(next) {
      if (this.account === next) return;
      this.cancel?.abort();
      this.account = next;
      this.cache = app.freshCache();
      this.overrides = { weights: {}, scale: null };
      this.signature = '';
      this.message = '';
      this.lastAttempt = 0;
      this.cursor = 0;
      this.lastPage = '';
      this.waitingTerm = false;
      this.update();
      if (!next) return;
      const [cache, local] = await Promise.all([
        request('get', next), chrome.storage.local.get(overrideKey(next))
      ]);
      if (this.account === next) {
        this.cache = cache;
        this.overrides = local[overrideKey(next)] ?? this.overrides;
      }
    }

    scanVisible() {
      const work = this.queue.then(() => this.readVisible());
      this.queue = work.catch(() => {});
      return work;
    }

    async readVisible() {
      const url = new URL(location.href);
      const detected = app.account(document, url);
      if (detected && this.documentAccount && detected !== this.documentAccount) this.accountChanged = true;
      if (detected && !this.documentAccount) this.documentAccount = detected;
      await this.identify(this.accountChanged ? null : detected);
      if (this.accountChanged) {
        this.context = null;
        this.message = 'The student account changed. Reload ManageBac to start a fresh scan.';
        this.update();
        return;
      }
      if (url.pathname !== location.pathname || url.search !== location.search || !app.studentPath(url.pathname)) return;
      const snapshot = app.scan(document, url);
      this.context = snapshot;
      const samePage = this.lastPage === url.pathname;
      const termChanged = samePage && this.lastTerm !== snapshot.term.id;
      const fingerprint = JSON.stringify(snapshot.records.map(({ termId, ...task }) => task));
      if (snapshot.context.type === 'tasks' && termChanged && fingerprint === this.lastFingerprint &&
        snapshot.records.length && document.querySelector(app.selectors.term) &&
        !document.querySelector('[data-task-list="all"][data-term-id="' + CSS.escape(snapshot.term.id ?? '') + '"]')) {
        this.waitingTerm = true;
      }
      const reflectsTerm = snapshot.term.id && document.querySelector('[data-task-list][data-term-id="' + CSS.escape(snapshot.term.id) + '"]');
      if (!samePage || reflectsTerm || fingerprint !== this.lastFingerprint) this.waitingTerm = false;
      this.lastPage = url.pathname;
      this.lastTerm = snapshot.term.id;
      this.lastFingerprint = fingerprint;
      snapshot.visible = true;
      const verified = this.waitingTerm ? { ...snapshot, records: [], complete: false, readable: false,
        weights: {}, scale: null } : snapshot;
      const signature = JSON.stringify({ ...verified, at: 0, route: url.pathname + url.search });
      if (signature !== this.signature) {
        this.signature = signature;
        await this.apply([verified]);
      }
      this.update();
    }

    async apply(snapshots) {
      const account = this.account;
      if (!account) {
        for (const snapshot of snapshots) app.mergeScan(this.cache, snapshot);
      } else {
        const cache = await request('scan', account, { snapshots });
        if (account === this.account) this.cache = cache;
      }
      this.update(true);
    }

    async setSettings(patch) {
      this.settings = { ...this.settings, ...patch };
      await chrome.storage.local.set({ [prefsKey]: this.settings });
      this.update();
    }

    async setOverrides(patch) {
      const next = { ...this.overrides, ...patch };
      if (this.account) await chrome.storage.local.set({ [overrideKey(this.account)]: next });
      this.overrides = next;
      this.update();
    }

    async clear() {
      this.cancel?.abort();
      await this.queue;
      if (this.account) await request('clear', this.account);
      this.cache = app.freshCache();
      this.overrides = { weights: {}, scale: null };
      this.message = 'Cached grades cleared.';
      this.update();
    }

    async refresh(manual = false) {
      if (this.refreshing || (!manual && document.visibilityState !== 'visible')) return;
      const interval = this.settings.refreshMinutes * 60000;
      if (!manual && (!interval || Date.now() - this.lastAttempt < interval)) return;
      this.lastAttempt = Date.now();
      this.refreshing = true;
      this.message = manual ? 'Checking student-visible pages…' : '';
      this.update();
      let account;
      let leased = false;
      try {
        if (manual) this.signature = '';
        await this.scanVisible();
        account = this.account;
        if (!account) {
          if (manual && !this.accountChanged) this.message = 'Checked this page. Background refresh needs an identifiable student profile.';
          return;
        }
        const current = this.context?.sources ?? [];
        const prioritized = [...new Set([...current, ...this.cache.sources])].filter((source) => {
          const url = app.localURL(source, location.href);
          return url && refreshable.test(url.pathname);
        }).sort((a, b) => Number(b.startsWith(app.workspacePath)) - Number(a.startsWith(app.workspacePath)));
        if (!prioritized.length) {
          if (manual) this.message = 'No class or task links found yet.';
          return;
        }
        leased = await request('lease', account, { manual, interval });
        if (!leased) {
          if (manual) this.message = 'A recent refresh already checked these pages.';
          return;
        }
        const first = this.cursor % prioritized.length;
        const pageLimit = 20;
        const batch = [...prioritized.slice(first), ...prioritized.slice(0, first)].slice(0, pageLimit);
        const controller = new AbortController();
        this.cancel = controller;
        const failures = [];
        const snapshots = [];
        for (const [index, source] of batch.entries()) {
          if (index) await new Promise((resolve) => setTimeout(resolve, 160));
          if (account !== this.account || controller.signal.aborted || (!manual && document.hidden)) break;
          try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5500)]);
            const requestedAt = Date.now();
            const page = await fetchPage(source, signal);
            if (!page || app.account(page.html, page.url) !== account || app.account(document, location.href) !== account) {
              failures.push(source);
              continue;
            }
            const snapshot = app.scan(page.html, page.url);
            snapshot.at = requestedAt;
            snapshot.defaultTerm = !page.url.search;
            if (controller.signal.aborted || account !== this.account) break;
            if (snapshot.readable) snapshots.push(snapshot);
            else failures.push(source);
          } catch {
            failures.push(source);
          }
        }
        if (controller.signal.aborted || account !== this.account) return;
        if (snapshots.length) await this.apply(snapshots);
        const count = snapshots.length;
        this.cursor = (first + batch.length) % prioritized.length;
        if (manual || failures.length) {
          this.message = count
            ? `Checked ${count} student page${count === 1 ? '' : 's'}.${failures.length ? ' Some pages had no verifiable data.' : ''}${prioritized.length > pageLimit ? ' More pages will be checked on a later refresh.' : ''}`
            : 'The checked pages exposed no verifiable grade data. Cached records were kept.';
        }
      } catch {
        this.message = 'Refresh could not finish. Cached records were kept.';
      } finally {
        if (leased) await request('release', account).catch(() => {});
        this.refreshing = false;
        this.update();
      }
    }
  }

  app.Sync = Sync;
})();
