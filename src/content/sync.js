(() => {
  const app = globalThis.MBGC;
  const prefsKey = 'mbgc:preferences';
  const overrideKey = (account) => 'mbgc:overrides:' + location.host + ':' + account;
  const parallelPages = 3;
  const pageLimit = 72;
  const requestSpacing = 160;
  const retryDelay = 3000;
  const scriptSelector = 'script[src],script:not([type]),script[type="module"],script[type="text/javascript"]';

  async function request(type, account, options = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'mbgc:' + type, account, ...options });
    if (!response || response.error) throw new Error(response?.error || 'Extension storage unavailable.');
    return response.value;
  }

  async function fetchPage(url, signal, etag) {
    const headers = { Accept: 'text/html' };
    if (etag) headers['If-None-Match'] = etag;
    const response = await fetch(url, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal, headers });
    if (response.type === 'opaqueredirect') return { redirected: true };
    if (response.status === 304 && etag) return { unchanged: true };
    const final = app.sourceURL(response.url, url);
    if (!response.ok || !final || !response.headers.get('content-type')?.includes('text/html')) return null;
    const body = await response.text();
    return { body, url: final, etag: response.headers.get('etag') };
  }

  async function readSelfProfile(signal) {
    const origin = location.origin;
    const read = async (path) => {
      const response = await fetch(origin + path, { credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(4500)]) });
      if (!response.ok || response.url !== origin + path || !response.headers.get('content-type')?.includes('text/html')) return null;
      return new DOMParser().parseFromString(await response.text(), 'text/html');
    };
    try {
      const profile = await read('/student/profile');
      if (!profile) return null;
      const evidence = app.accountEvidence(profile, origin + '/student/profile');
      if (evidence.status === 'conflicting') return null;
      if (evidence.id) return evidence.id;
      const hasEditLink = [...profile.querySelectorAll('a[href]')].some((link) => {
        const target = app.localURL(link.getAttribute('href'), origin + '/student/profile');
        return target?.pathname === '/student/profile/edit' && !target.search &&
          [link.textContent, link.getAttribute('aria-label'), link.getAttribute('title')]
            .some((label) => /^edit profile$/i.test(app.clean(label)));
      });
      const email = app.profileEmail(profile) ?? (hasEditLink ? app.profileEmail(await read('/student/profile/edit')) : null);
      if (!email) return null;
      const fingerprint = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(origin + '\n' + email));
      return 'profile-' + [...new Uint8Array(fingerprint)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      return null;
    }
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
    openedAt = Date.now();

    constructor(update) {
      this.update = update;
      chrome.runtime.onMessage.addListener((message, sender) => {
        const account = this.account;
        if (sender.id !== chrome.runtime.id || message?.type !== 'mbgc:cache-updated' || !account || message.account !== account) return;
        clearTimeout(this.noticeTimer);
        this.noticeTimer = setTimeout(async () => {
          try {
            if (this.profileIdentity) {
              const confirmed = await readSelfProfile(new AbortController().signal);
              if (this.account !== account) return;
              if (confirmed !== account) {
                this.identityStatus = 'profile-unverified';
                await this.identify(null);
                return;
              }
            }
            await this.readCache(account);
          } catch {
            // A later page scan can retry the cache read.
          }
        }, 100);
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

    cursor() {
      return this.storageState === 'session' ? { since: this.cache.revision, epoch: this.cache.clearedAt } : {};
    }

    async readCache(account, full = false) {
      const reply = await request('get', account, full ? {} : this.cursor());
      if (this.account !== account) return;
      if (!this.installCache(reply) && !full) return this.readCache(account, true);
      this.update();
    }

    installCache(reply) {
      const previous = this.cache;
      if (this.storageState === 'session' && ((reply.clearedAt ?? 0) < (previous.clearedAt ?? 0) ||
        (reply.clearedAt === previous.clearedAt && reply.revision <= previous.revision))) return true;
      const { base, ...cache } = reply;
      if (base !== undefined) {
        if (base !== previous.revision || cache.clearedAt !== previous.clearedAt) return false;
        this.cache = { ...previous, ...cache, classes: { ...previous.classes, ...cache.classes } };
      } else this.cache = cache;
      this.revision++;
      return true;
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
      this.refreshIssue = false;
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
      if (rows && this.account === app.account(document, url) && this.lastPage === url.pathname && this.lastSearch === url.search &&
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
      const evidence = app.accountEvidence(document, url);
      this.identityStatus = evidence.status;
      let detected = evidence.id;
      this.profileIdentity = !detected && evidence.status !== 'conflicting' && app.studentPath(url.pathname);
      if (this.profileIdentity) {
        const recentlyFailed = !this.account && Date.now() - (this.profileAttempt ?? 0) < 3000;
        if (!recentlyFailed) {
          this.profileAttempt = Date.now();
          detected = await readSelfProfile(new AbortController().signal);
        }
        if (!detected) this.identityStatus = 'profile-unverified';
      }
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
      const termChanged = samePage && this.lastTerm && this.lastTerm !== snapshot.term.id;
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
        weights: {}, scale: null, loading: true } : snapshot;
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
          const cache = await request('scan', account, { snapshots: batch, checks: allChecks, ...this.cursor() });
          if (account !== this.account) return;
          if (!this.installCache(cache)) await this.readCache(account, true);
          if (account !== this.account) return;
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

    async inspectSource(source, url, signal, account, detail) {
      const storedCheck = this.cache.sourceChecks?.[source];
      const previous = !detail || (storedCheck?.termId === detail.termId && app.validScore(detail)) ? storedCheck : null;
      const route = app.route(url);
      const requested = app.termFromURL(url);
      const check = { source, classId: route.classId, termId: detail?.termId ?? requested?.id ?? previous?.termId, detail: Boolean(detail), at: Date.now() };
      try {
        const page = await fetchPage(url, AbortSignal.any([signal, AbortSignal.timeout(5500)]), previous?.error ? undefined : previous?.etag);
        if (!page) return { check: { ...check, error: 'The student page could not be read. Try Refresh now or open Class Tasks.' } };
        if (page.redirected) return { check: { ...check, renderedCandidate: ['tasks', 'roster'].includes(route.type),
          error: 'ManageBac redirected the student page. The destination needs verification.' } };
        if (page.unchanged && previous && !previous.error) return { check: { ...previous, at: check.at, unchanged: true }, ok: true };
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(page.body)))]
          .map((byte) => byte.toString(16).padStart(2, '0')).join('');
        if (hash === previous?.hash && !previous.error) {
          return { check: { ...previous, at: check.at, unchanged: true, etag: page.etag || undefined }, ok: true };
        }
        const html = new DOMParser().parseFromString(page.body, 'text/html');
        const evidence = app.accountEvidence(html, page.url);
        if (!this.matchesAccount(evidence, account)) return { check: { ...check,
          error: 'The returned HTML did not verify the student account.',
          renderedCandidate: evidence.status !== 'conflicting' && !evidence.id && ['tasks', 'roster'].includes(route.type) } };
        if (detail) {
          const scan = app.scanTaskDetail(html, page.url, detail);
          if (scan) scan.at = check.at;
          return { snapshot: scan, check: { ...check, termId: detail.termId, detail: true,
            error: scan ? undefined : 'The linked result did not expose verified assignment points.',
            hash: scan ? hash : undefined, etag: scan ? page.etag || undefined : undefined }, ok: Boolean(scan) };
        }
        const snapshot = app.scan(html, page.url);
        snapshot.at = check.at;
        snapshot.defaultTerm = !page.url.search;
        if (requested && requested.id !== snapshot.term.id) return { check: { ...check,
          renderedCandidate: true, error: 'The requested term was not present in the returned HTML.' } };
        check.termId = snapshot.term.id ?? check.termId;
        let error;
        let renderedCandidate = false;
        if (route.type === 'tasks') {
          const hasRows = snapshot.records.some((task) => task.termId === snapshot.term.id);
          const missingPoints = !snapshot.diagnostic.points;
          const missingWeights = !snapshot.diagnostic.weights;
          const cached = this.cache.classes[route.classId]?.terms['term:' + snapshot.term.id];
          const changedScore = !snapshot.complete && snapshot.records.some((row) => {
            const prior = cached?.records[row.id];
            return row.termId === snapshot.term.id && prior && app.validScore(prior) && app.validScore(row) &&
              (row.earnedPoints !== prior.earnedPoints || row.maxPoints !== prior.maxPoints);
          });
          const dynamic = (missingPoints || missingWeights) && Boolean(html.querySelector(scriptSelector));
          if (!snapshot.term.id) {
            error = 'No verified term in the returned page. Check the native term selector.';
          } else if (snapshot.diagnostic.loading || (!snapshot.complete && !hasRows) ||
            (dynamic && hasRows) || (missingPoints && Object.values(cached?.records ?? {}).some(app.validScore))) {
            error = missingPoints ? 'No verifiable task scores in the returned HTML. The page may load results after rendering.' :
              'The task results or category weights are still loading.';
          }
          if (changedScore) {
            error = 'A score changed on a partial task list. Checking the rendered result.';
            check.changedScore = true;
          }
          renderedCandidate = Boolean(error);
        } else if (route.type === 'roster' && !Object.keys(snapshot.classes).length) {
          error = 'The class list did not expose enrolled class links in its HTML.';
          renderedCandidate = true;
        }
        if (error) snapshot.complete = false;
        if (snapshot.diagnostic.loading) {
          snapshot.loading = true;
          snapshot.records = [];
          snapshot.weights = {};
          snapshot.scale = null;
          snapshot.readable = false;
        }
        return { snapshot, check: { ...check, error, renderedCandidate,
          hash: !error ? hash : undefined, etag: !error && page.etag ? page.etag : undefined, complete: snapshot.complete },
          ok: !error && (snapshot.readable || route.type === 'roster') };
      } catch {
        return { check: { ...check, error: 'The student page did not respond. Try Refresh now again.' } };
      }
    }

    matchesAccount(evidence, account) {
      return evidence.id === account || (this.profileIdentity && !evidence.id && evidence.status !== 'conflicting');
    }

    async renderedSource(url, account, signal) {
      const started = Date.now();
      const frame = document.createElement('iframe');
      frame.className = 'mbgc-owned';
      frame.hidden = true;
      frame.setAttribute('inert', '');
      frame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
      try {
        await new Promise((resolve, reject) => {
          const limit = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
          const abort = () => reject(limit.reason);
          if (limit.aborted) return abort();
          limit.addEventListener('abort', abort, { once: true });
          frame.addEventListener('load', () => {
            limit.removeEventListener('abort', abort);
            resolve();
          }, { once: true });
          frame.src = url.href;
          document.body.append(frame);
        });
        const wanted = app.route(url);
        const selected = app.termFromURL(url);
        // Native controls, score rows and weights can hydrate in separate DOM updates.
        const deadline = performance.now() + 4500;
        let best = null;
        let openedTermMenu = false;
        let dirty = true;
        const doc = frame.contentDocument;
        if (!doc) return null;
        const observer = new MutationObserver(() => { dirty = true; });
        observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
        try {
          while (!signal.aborted && performance.now() < deadline) {
            if (dirty) {
              dirty = false;
              best = null;
              const actual = app.sourceURL(doc.URL, url);
              if (doc !== frame.contentDocument || !actual ||
                app.route(actual).type !== wanted.type || app.route(actual).classId !== wanted.classId) return null;
              const identity = app.accountEvidence(doc, actual);
              if (identity.status === 'conflicting' || (identity.id && identity.id !== account)) return null;
              if (this.matchesAccount(identity, account)) {
                const scan = app.scan(doc, actual);
                if (wanted.type === 'tasks' && !scan.term.id && !openedTermMenu) {
                  const surface = app.taskSurface(doc);
                  const controls = [...(surface.section?.querySelectorAll('button[aria-haspopup],button[role="combobox"],button.dropdown-toggle') ?? [])]
                    .filter((button) => !button.disabled && !button.closest('form,[hidden],[aria-hidden="true"]') &&
                      button.getAttribute('aria-expanded') !== 'true' && /\b(?:semester|term|quarter|trimester)\b/i.test(button.textContent));
                  if (controls.length === 1) {
                    openedTermMenu = true;
                    controls[0].click();
                  }
                }
                if (wanted.type === 'roster' && Object.keys(scan.classes).length) return scan;
                if (scan.term.id && (!selected || selected.id === scan.term.id) && !scan.diagnostic.loading) {
                  if (scan.diagnostic.points || scan.complete) {
                    const previous = this.cache.classes[wanted.classId]?.terms['term:' + scan.term.id];
                    if (!scan.diagnostic.points && Object.values(previous?.records ?? {}).some(app.validScore)) best = null;
                    else best = { ...scan, at: started, defaultTerm: !actual.search, sourceKind: 'rendered' };
                    if (scan.diagnostic.points && scan.diagnostic.weights) return best;
                  }
                }
              } else best = null;
              if (!doc.querySelector(scriptSelector)) return best;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          return !signal.aborted && doc === frame.contentDocument && this.matchesAccount(app.accountEvidence(doc, url), account) ? best : null;
        } finally {
          observer.disconnect();
        }
      } catch {
        // Framing or navigation can be blocked by the school site.
      } finally {
        frame.remove();
      }
      return null;
    }

    async refresh(manual = false) {
      if (this.refreshing || (!manual && (document.visibilityState !== 'visible' ||
        !['#mbgc-overall-grades', '#mbgc-grade-estimator'].includes(location.hash)))) return;
      const interval = this.settings.refreshMinutes * 60000;
      if (!manual && !interval) return;
      if (manual || !this.context || this.storageState === 'unavailable') await this.scanVisible();
      if (this.refreshing || (!manual && document.hidden)) return;
      const account = this.account;
      if (!account || this.storageState === 'unavailable') {
        if (manual && !this.accountChanged && !account) {
          this.message = 'Background refresh needs a verifiable student account. Grades on this tab remain available.';
          this.refreshIssue = true;
          this.update();
        }
        return;
      }
      const urls = this.sources();
      const now = Date.now();
      if (!manual) for (const source of urls.keys()) {
        const checkedAt = this.cache.sourceChecks?.[source]?.at;
        if (checkedAt && now - checkedAt < interval) urls.delete(source);
      }
      if (!urls.size) return;
      const hasNewSources = [...urls.keys()].some((source) => !this.cache.sourceChecks?.[source]);
      if (!manual && now - this.lastAttempt < (hasNewSources ? retryDelay : interval)) return;
      this.lastAttempt = now;
      this.refreshing = true;
      const controller = new AbortController();
      this.cancel = controller;
      this.manualRefresh = manual;
      this.message = manual ? 'Checking student-visible pages…' : '';
      this.refreshIssue = false;
      this.update();
      let token;
      try {
        token = await request('lease', account, { manual, interval, hasNewSources });
        if (!token) {
          if (manual) {
            this.message = 'Another tab is refreshing grades or a refresh just finished.';
            this.refreshIssue = true;
          }
          return;
        }
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(75000)]);
        const confirmAccount = async () => {
          if (signal.aborted || account !== this.account) return false;
          const current = app.accountEvidence(document, location.href);
          if (!this.profileIdentity || current.id || current.status === 'conflicting') return current.id === account;
          const confirmed = await readSelfProfile(signal);
          if (signal.aborted || account !== this.account) return false;
          if (confirmed === account) return true;
          this.identityStatus = 'profile-unverified';
          await this.identify(null);
          this.message = 'The signed-in profile could not be reverified. Refresh to check it again.';
          this.refreshIssue = true;
          return false;
        };
        if (!await confirmAccount()) return;
        const seen = new Set();
        const pending = [...urls.values()].sort((a, b) => {
          const rank = (url) => app.route(url).type === 'roster' ? 0 : app.route(url).type === 'workspace' ? 1 : url.search ? 3 : 2;
          const checkedAt = (url) => this.cache.sourceChecks?.[url.pathname + url.search]?.at ?? 0;
          return rank(a) - rank(b) || checkedAt(a) - checkedAt(b);
        });
        const queued = new Set(this.sources().keys());
        let checked = 0;
        let failures = 0;
        let unchanged = 0;
        const renderedChecks = [];
        const details = new Map();
        let staged = [];
        let checksToCommit = [];
        let lastCommit = performance.now();
        const flush = async () => {
          if (!staged.length && !checksToCommit.length) return;
          if (!await confirmAccount()) {
            controller.abort();
            return;
          }
          await this.apply(staged, checksToCommit);
          staged = [];
          checksToCommit = [];
          lastCommit = performance.now();
        };
        let renderAttempts = 0;
        const discover = (snapshot) => {
          for (const source of snapshot.sources) {
            if (queued.has(source)) continue;
            const url = app.sourceURL(source, location.href);
            if (!url) continue;
            queued.add(source);
            if (app.route(url).type === 'roster') pending.unshift(url);
            else pending.push(url);
          }
        };
        let checkedDetails = false;
        while ((pending.length || !checkedDetails || (renderedChecks.length && renderAttempts < 6)) && seen.size < pageLimit && !signal.aborted) {
          if (!pending.length) {
            await flush();
            if (document.hidden) break;
            if (!checkedDetails && (!renderedChecks.length || renderAttempts >= 6)) {
              checkedDetails = true;
              const candidates = new Map();
              for (const subject of Object.values(this.cache.classes)) {
                for (const bucket of Object.values(subject.terms)) {
                  for (const task of Object.values(bucket.records)) {
                    if (!task.termId || !task.resultsLink || !task.taskUrl) continue;
                    const prior = candidates.get(task.taskUrl);
                    candidates.set(task.taskUrl, candidates.has(task.taskUrl) && prior?.termId !== task.termId ? null : task);
                  }
                }
              }
              const checkedAt = (task) => this.cache.sourceChecks?.[task.taskUrl]?.at ?? 0;
              const due = [...candidates.values()].filter((task) => task && (task.gradeKind === 'letter' || task.fromDetail) &&
                (manual || !checkedAt(task) || now - checkedAt(task) >= interval)).sort((a, b) => checkedAt(a) - checkedAt(b));
              for (const task of due.slice(0, 4)) {
                const target = app.sourceURL(task.taskUrl, location.href);
                if (target && app.route(target).type === 'task') {
                  details.set(task.taskUrl, task);
                  pending.push(target);
                }
              }
              continue;
            }
            renderedChecks.sort((a, b) => (this.cache.sourceChecks?.[a.source]?.renderedAt ?? 0) -
              (this.cache.sourceChecks?.[b.source]?.renderedAt ?? 0));
            const check = renderedChecks.shift();
            const subject = this.cache.classes[check.classId];
            const bucket = subject?.terms[check.termId ? 'term:' + check.termId : app.classTermKey(subject)];
            if (!check.changedScore && bucket?.lastSource === 'rendered' && Date.now() - bucket.lastScan < Math.max(interval, 60000) &&
              Object.values(bucket.records).some(app.validScore)) continue;
            renderAttempts++;
            const target = app.sourceURL(check.source, location.href);
            const rendered = await this.renderedSource(target, account, signal);
            if (!await confirmAccount()) return;
            if (rendered) {
              checked++;
              failures--;
              await this.apply([rendered], [{ ...check, at: rendered.at, error: undefined,
                termId: rendered.term.id, renderedAt: rendered.at, renderedCandidate: false, complete: rendered.complete }]);
              discover(rendered);
            } else {
              const at = Date.now();
              await this.apply([], [{ ...check, at, renderedAt: at,
                error: check.error + ' A rendered read did not expose verifiable results.' }]);
            }
            continue;
          }
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
            return this.inspectSource(source, url, signal, account, details.get(source));
          }));
          if (signal.aborted || account !== this.account) return;
          for (const result of results.filter(Boolean)) {
            if (result.check.renderedCandidate) renderedChecks.push(result.check);
            if (result.check.unchanged) unchanged++;
            if (result.ok) checked++;
            if (result.check.error) failures++;
            checksToCommit.push(result.check);
            if (!result.snapshot) continue;
            staged.push(result.snapshot);
            discover(result.snapshot);
          }
          if (performance.now() - lastCommit >= 650 || staged.some((scan) => scan.context.type === 'roster')) await flush();
          if (pending.length && !signal.aborted) await new Promise((resolve) => setTimeout(resolve, requestSpacing));
        }
        if (!controller.signal.aborted && account === this.account) await flush();
        if (signal.aborted || account !== this.account) return;
        this.refreshIssue = Boolean(failures || pending.length || renderedChecks.length);
        if (manual || failures || pending.length || renderedChecks.length) this.message = [
          checked ? `Checked ${checked} student pages.` : 'Background refresh found no new usable data.',
          unchanged ? `${unchanged} unchanged.` : '',
          failures ? `${failures} pages could not be verified. See subject details.` : '',
          (pending.length || renderedChecks.length) ? 'Remaining pages will be checked on a later refresh.' : ''
        ].filter(Boolean).join(' ');
      } catch {
        if (!controller.signal.aborted) {
          this.message = 'Refresh could not finish. Cached records were kept.';
          this.refreshIssue = true;
        }
      } finally {
        if (token) await request('release', account, { token, aborted: controller.signal.aborted }).catch(() => {});
        this.refreshing = false;
        this.update();
      }
    }
  }

  app.Sync = Sync;
})();
