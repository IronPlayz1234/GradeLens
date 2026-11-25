(() => {
  const app = globalThis.MBGC;
  const prefsKey = 'mbgc:preferences';
  const overrideKey = (account) => 'mbgc:overrides:' + location.host + ':' + account;
  const parallelPages = 3;
  const pageLimit = 72;
  const requestSpacing = 160;
  const retryDelay = 3000;

  async function request(type, account, options = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'mbgc:' + type, account, ...options });
    if (!response || response.error) throw new Error(response?.error || 'Extension storage unavailable.');
    return response.value;
  }

  async function fetchPage(url, signal, etag) {
    const headers = { Accept: 'text/html' };
    if (etag) headers['If-None-Match'] = etag;
    const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal, headers });
    if (response.status === 304 && etag) return { unchanged: true };
    const final = app.sourceURL(response.url, url);
    if (!response.ok || !final || !response.headers.get('content-type')?.includes('text/html')) return null;
    const html = new DOMParser().parseFromString(await response.text(), 'text/html');
    return { html, url: final, etag: response.headers.get('etag') };
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
    context = null;
    queue = Promise.resolve();
    diagnostics = null;
    storageState = 'document';
    pendingSnapshots = [];
    pendingChecks = [];
    revision = 0;

    constructor(update) {
      this.update = update;
      chrome.runtime.onMessage.addListener((message, sender) => {
        const account = this.account;
        if (sender.id !== chrome.runtime.id || message?.type !== 'mbgc:cache-updated' || !account || message.account !== account) return;
        request('get', account).then((cache) => {
          if (this.account === account) {
            this.installCache(cache);
            this.update();
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

    installCache(cache) {
      if (cache.revision === this.cache.revision && cache.clearedAt === this.cache.clearedAt &&
        this.storageState === 'session') return;
      // A late response from another tab cannot roll back newer committed data.
      if (this.storageState === 'session' && ((cache.clearedAt ?? 0) < (this.cache.clearedAt ?? 0) ||
        (cache.clearedAt === this.cache.clearedAt && (cache.revision ?? 0) < (this.cache.revision ?? 0)))) return;
      this.cache = cache;
      this.revision++;
    }

    async init() {
      this.settings = { ...app.settingsDefaults, ...(await chrome.storage.local.get(prefsKey))[prefsKey] };
    }

    async identify(next) {
      if (this.account === next) return;
      this.cancel?.abort();
      this.account = next;
      this.cache = app.freshCache();
      this.revision++;
      this.overrides = { weights: {}, scale: null };
      this.signature = '';
      this.pendingSnapshots = [];
      this.pendingChecks = [];
      this.storageState = next ? 'checking' : 'document';
      this.message = '';
      this.lastAttempt = 0;
      this.diagnostics = null;
      this.lastPage = '';
      this.waitingTerm = false;
      this.update();
      if (!next) return;
      const [cache, local] = await Promise.allSettled([
        request('get', next), chrome.storage.local.get(overrideKey(next))
      ]);
      if (this.account !== next) return;
      if (cache.status === 'fulfilled') {
        this.installCache(cache.value);
        this.storageState = 'session';
      } else this.storageState = 'unavailable';
      if (local.status === 'fulfilled') this.overrides = local.value[overrideKey(next)] ?? this.overrides;
    }

    scanVisible(rows = null) {
      const work = this.queue.then(() => this.readVisible(rows));
      this.queue = work.catch(() => {});
      return work;
    }

    async readVisible(rows) {
      const url = new URL(location.href);
      if (rows && this.lastPage === url.pathname && this.lastSearch === url.search &&
        !this.diagnostics?.loading && !this.accountChanged && this.storageState !== 'unavailable') {
        const changes = app.readScoreChanges(url, this.context, rows);
        if (changes) {
          if (changes.length) {
            const byId = new Map(changes.map((task) => [task.id, task]));
            const records = this.context.records.map((task) => byId.get(task.id) ?? task);
            const diagnostic = { ...this.context.diagnostic, points: records.filter(app.validScore).length,
              scoreIssues: records.filter((task) => task.issue && !app.validScore(task)).length };
            this.context = { ...this.context, records, diagnostic };
            this.diagnostics = { ...diagnostic, loading: false };
            this.signature = JSON.stringify({ ...this.context, at: 0, route: url.pathname + url.search });
            this.lastFingerprint = JSON.stringify(records.map(({ termId, ...task }) => task));
            await this.apply([{ ...this.context, visible: true, incremental: true, records: changes,
              sources: [], classes: {}, at: Date.now() }]);
          }
          return;
        }
      }
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
      this.lastSearch = url.search;
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

    async apply(snapshots, checks = []) {
      const account = this.account;
      if (!account) {
        for (const snapshot of snapshots) app.mergeScan(this.cache, snapshot);
        this.revision++;
      } else {
        const batch = [...this.pendingSnapshots, ...snapshots];
        const allChecks = [...this.pendingChecks, ...checks];
        try {
          const cache = await request('scan', account, { snapshots: batch, checks: allChecks });
          if (account !== this.account) return;
          this.installCache(cache);
          this.pendingSnapshots = [];
          this.pendingChecks = [];
          this.storageState = 'session';
        } catch {
          if (account !== this.account) return;
          this.storageState = 'unavailable';
          this.pendingSnapshots = batch.slice(-30);
          this.pendingChecks = allChecks.slice(-72);
          for (const snapshot of snapshots) app.mergeScan(this.cache, snapshot);
          for (const check of checks) app.mergeCheck(this.cache, check);
          this.revision++;
        }
      }
      this.update();
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
      const account = this.account;
      const cleared = account ? await request('clear', account) : app.freshCache();
      if (account !== this.account) return;
      this.cache = cleared;
      this.signature = '';
      this.revision++;
      this.pendingSnapshots = [];
      this.pendingChecks = [];
      this.overrides = { weights: {}, scale: null };
      this.message = 'Cached grades cleared.';
      this.update();
    }

    sources() {
      const urls = new Map();
      for (const candidate of [...(this.context?.sources ?? []), ...this.cache.sources]) {
        const url = app.sourceURL(candidate, location.href);
        if (!url) continue;
        const bare = this.cache.sourceChecks?.[url.pathname];
        const selected = app.termFromURL(url);
        if (selected && bare?.termId === selected.id && !bare.error) continue;
        urls.set(url.pathname + url.search, url);
      }
      return urls;
    }

    stopRefresh() {
      this.cancel?.abort();
      this.lastAttempt = 0;
    }

    async inspectSource(source, url, signal, account) {
      const previous = this.cache.sourceChecks?.[source];
      const route = app.route(url);
      const requested = app.termFromURL(url);
      const check = { source, classId: route.classId, termId: requested?.id ?? previous?.termId, at: Date.now() };
      try {
        const page = await fetchPage(url, AbortSignal.any([signal, AbortSignal.timeout(5500)]), previous?.etag);
        if (!page) return { check: { ...check, error: 'The student page could not be read. Try Refresh now or open Class Tasks.' } };
        if (page.unchanged) return { check: { ...check, unchanged: true, etag: previous.etag }, ok: true };
        if (app.account(page.html, page.url) !== account) return { check: { ...check,
          error: 'The student identity could not be verified in this page. Open Class Tasks to sync what is visible.' } };
        const snapshot = app.scan(page.html, page.url);
        snapshot.at = check.at;
        snapshot.defaultTerm = !page.url.search;
        if (requested && requested.id !== snapshot.term.id) return { check: { ...check,
          error: 'The requested term was not present in the returned page. Select it in Class Tasks.' } };
        check.termId = snapshot.term.id ?? check.termId;
        let error;
        if (route.type === 'tasks') {
          if (!snapshot.term.id) error = 'No verified term in the returned page. Check the native term selector.';
          else if (!snapshot.records.some((task) => task.termId === snapshot.term.id)) {
            const prior = this.cache.classes[route.classId]?.terms['term:' + snapshot.term.id];
            if (!snapshot.complete || Object.keys(prior?.records ?? {}).length) {
              error = 'No task rows in the returned page. Open Class Tasks if assessments load after rendering.';
            }
          }
        } else if (route.type === 'roster' && !Object.keys(snapshot.classes).length) {
          error = 'The class list did not expose enrolled class links in its HTML.';
        }
        // Only validate exact HTML that was parsed successfully and contained useful data.
        return { snapshot, check: { ...check, error, etag: !error && page.etag ? page.etag : undefined },
          ok: !error && (snapshot.readable || route.type === 'roster') };
      } catch {
        return { check: { ...check, error: 'The student page did not respond. Try Refresh now again.' } };
      }
    }

    async refresh(manual = false) {
      if (this.refreshing || (!manual && document.visibilityState !== 'visible')) return;
      const interval = this.settings.refreshMinutes * 60000;
      if (!manual && !interval) return;
      if (manual || !this.context || this.storageState === 'unavailable') await this.scanVisible();
      if (this.refreshing || (!manual && document.hidden)) return;
      const account = this.account;
      if (!account || this.storageState === 'unavailable') {
        if (manual && !this.accountChanged && !account) {
          this.message = 'Background refresh needs a verifiable student account. Grades on this tab remain available.';
          this.update();
        }
        return;
      }
      const urls = this.sources();
      if (!urls.size) return;
      const now = Date.now();
      const hasNewSources = [...urls.keys()].some((source) => !this.cache.sourceChecks?.[source]);
      if (!manual && now - this.lastAttempt < (hasNewSources ? retryDelay : interval)) return;
      this.lastAttempt = now;
      this.refreshing = true;
      const controller = new AbortController();
      this.cancel = controller;
      this.manualRefresh = manual;
      this.message = manual ? 'Checking student-visible pages…' : '';
      this.update();
      let token;
      try {
        token = await request('lease', account, { manual, interval, hasNewSources });
        if (!token) {
          if (manual) this.message = 'Another tab is refreshing grades or a refresh just finished.';
          return;
        }
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(75000)]);
        const seen = new Set();
        const pending = [...urls.values()].sort((a, b) => {
          const rank = (url) => app.route(url).type === 'roster' ? 0 : app.route(url).type === 'workspace' ? 1 : url.search ? 3 : 2;
          const checkedAt = (url) => this.cache.sourceChecks?.[url.pathname + url.search]?.at ?? 0;
          return rank(a) - rank(b) || checkedAt(a) - checkedAt(b);
        });
        const queued = new Set(urls.keys());
        let checked = 0;
        let failures = 0;
        let unchanged = 0;
        while (pending.length && seen.size < pageLimit && !signal.aborted) {
          const batch = pending.splice(0, Math.min(parallelPages, pageLimit - seen.size)).filter((url) => {
            const id = app.termFromURL(url)?.id;
            const bare = this.cache.sourceChecks?.[url.pathname];
            return !id || !seen.has(url.pathname) || bare?.termId !== id || Boolean(bare.error);
          });
          if (!batch.length) continue;
          const results = await Promise.all(batch.map(async (url, index) => {
            const source = url.pathname + url.search;
            if (index) await new Promise((resolve) => setTimeout(resolve, index * requestSpacing));
            if (signal.aborted) return null;
            seen.add(source);
            return this.inspectSource(source, url, signal, account);
          }));
          if (controller.signal.aborted || account !== this.account || app.account(document, location.href) !== account) return;
          const snapshots = [];
          const checks = [];
          for (const result of results.filter(Boolean)) {
            if (result.check.unchanged) unchanged++;
            if (result.ok) checked++;
            if (result.check.error) failures++;
            checks.push(result.check);
            if (!result.snapshot) continue;
            snapshots.push(result.snapshot);
            for (const source of result.snapshot.sources) {
              if (queued.has(source)) continue;
              const url = app.sourceURL(source, location.href);
              if (url) {
                queued.add(source);
                const rank = app.route(url).type;
                if (rank === 'roster') pending.unshift(url);
                else pending.push(url);
              }
            }
          }
          if (snapshots.length || checks.length) await this.apply(snapshots, checks);
          if (pending.length && !signal.aborted) await new Promise((resolve) => setTimeout(resolve, requestSpacing));
        }
        if (manual || failures || pending.length) this.message = [
          checked ? `Checked ${checked} student pages.` : 'Background refresh found no new usable data.',
          unchanged ? `${unchanged} unchanged.` : '',
          failures ? `${failures} pages could not be verified. See subject details.` : '',
          pending.length ? 'Remaining pages will be checked on a later refresh.' : ''
        ].filter(Boolean).join(' ');
      } catch {
        if (!controller.signal.aborted) this.message = 'Refresh could not finish. Cached records were kept.';
      } finally {
        if (token) await request('release', account, { token }).catch(() => {});
        this.refreshing = false;
        this.update();
      }
    }
  }

  app.Sync = Sync;
})();
