(() => {
  const app = globalThis.MBGC;
  const prefsKey = 'mbgc:preferences';
  const overrideKey = (account) => 'mbgc:overrides:' + location.host + ':' + account;
  const refreshable = /^\/student\/(?:classes\/\d+\/(?:core_tasks|tasks)|tasks_and_deadlines)\/?$/;

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
    diagnostics = null;
    storageState = 'document';
    pendingSnapshots = [];

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
      this.pendingSnapshots = [];
      this.storageState = next ? 'checking' : 'document';
      this.message = '';
      this.lastAttempt = 0;
      this.diagnostics = null;
      this.cursor = 0;
      this.lastPage = '';
      this.waitingTerm = false;
      this.update();
      if (!next) return;
      const [cache, local] = await Promise.allSettled([
        request('get', next), chrome.storage.local.get(overrideKey(next))
      ]);
      if (this.account !== next) return;
      if (cache.status === 'fulfilled') {
        this.cache = cache.value;
        this.storageState = 'session';
      } else this.storageState = 'unavailable';
      if (local.status === 'fulfilled') this.overrides = local.value[overrideKey(next)] ?? this.overrides;
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
      let snapshot;
      try {
        snapshot = app.scan(document, url);
      } catch {
        this.diagnostics = { page: app.route(url).type, failed: true };
        this.update();
        return;
      }
      this.context = snapshot;
      const samePage = this.lastPage === url.pathname;
      const termChanged = samePage && this.lastTerm !== snapshot.term.id;
      const fingerprint = JSON.stringify(snapshot.records.map(({ termId, ...task }) => task));
      if (snapshot.context.type === 'tasks' && termChanged && fingerprint === this.lastFingerprint &&
        snapshot.records.length && snapshot.term.id &&
        !document.querySelector('[data-task-list="all"][data-term-id="' + CSS.escape(snapshot.term.id ?? '') + '"]')) {
        this.waitingTerm = true;
      }
      const reflectsTerm = snapshot.term.id && document.querySelector('[data-task-list][data-term-id="' + CSS.escape(snapshot.term.id) + '"]');
      if (!samePage || reflectsTerm || fingerprint !== this.lastFingerprint) this.waitingTerm = false;
      const renderedTerm = document.querySelector('[data-task-list][data-term-id]')?.getAttribute('data-term-id');
      if (snapshot.context.type === 'tasks' && snapshot.term.id && renderedTerm && renderedTerm !== snapshot.term.id) {
        this.waitingTerm = true;
      }
      this.lastPage = url.pathname;
      this.lastTerm = snapshot.term.id;
      this.lastFingerprint = fingerprint;
      snapshot.visible = true;
      this.diagnostics = { ...snapshot.diagnostic, loading: this.waitingTerm || snapshot.diagnostic.loading };
      const verified = this.diagnostics.loading ? { ...snapshot, records: [], complete: false, readable: false,
        weights: {}, scale: null } : snapshot;
      const signature = JSON.stringify({ ...verified, at: 0, route: url.pathname + url.search });
      if (signature !== this.signature || this.storageState === 'unavailable') {
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
        const batch = [...this.pendingSnapshots, ...snapshots];
        try {
          const cache = await request('scan', account, { snapshots: batch });
          if (account !== this.account) return;
          this.cache = cache;
          this.pendingSnapshots = [];
          this.storageState = 'session';
        } catch {
          if (account !== this.account) return;
          this.storageState = 'unavailable';
          this.pendingSnapshots = batch.slice(-20);
          for (const snapshot of snapshots) app.mergeScan(this.cache, snapshot);
        }
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
      this.pendingSnapshots = [];
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
        if (this.storageState === 'unavailable') return;
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
        let failures = 0;
        let unverifiableIdentity = 0;
        const snapshots = [];
        for (const [index, source] of batch.entries()) {
          if (index) await new Promise((resolve) => setTimeout(resolve, 160));
          if (account !== this.account || controller.signal.aborted || (!manual && document.hidden)) break;
          try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5500)]);
            const requestedAt = Date.now();
            const page = await fetchPage(source, signal);
            if (!page) { failures++; continue; }
            if (app.account(page.html, page.url) !== account || app.account(document, location.href) !== account) {
              unverifiableIdentity++;
              continue;
            }
            const snapshot = app.scan(page.html, page.url);
            snapshot.at = requestedAt;
            snapshot.defaultTerm = !page.url.search;
            if (controller.signal.aborted || account !== this.account) break;
            const requested = app.termFromURL(new URL(source, location.href));
            if (snapshot.readable && (!requested || requested.id === snapshot.term.id)) snapshots.push(snapshot);
            else failures++;
          } catch {
            failures++;
          }
        }
        if (controller.signal.aborted || account !== this.account) return;
        if (snapshots.length) await this.apply(snapshots);
        const count = snapshots.length;
        this.cursor = (first + batch.length) % prioritized.length;
        if (manual || failures || unverifiableIdentity) {
          const result = count ? `Checked ${count} student page${count === 1 ? '' : 's'}.` :
            'Background refresh found no usable data. Cached records were kept.';
          this.message = [result,
            failures ? `${failures} pages did not expose a verifiable task list or requested term.` : '',
            unverifiableIdentity ? `${unverifiableIdentity} pages skipped because the student could not be verified.` : '',
            prioritized.length > pageLimit ? 'More pages will be checked on a later refresh.' : ''].filter(Boolean).join(' ');
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
