const historyIssues = new Map();
const historyStorageKey = (account) => 'mbgc:history:' + new URL(origin).host + ':' + account;

async function readLocalHistory(account) {
  const key = historyStorageKey(account);
  const history = (await chrome.storage.local.get(key))[key];
  if (history && history.version !== 1) throw new Error('This saved grade history uses a newer version.');
  return history ?? app.emptyHistory();
}

async function historyOwner(account) {
  const identity = new TextEncoder().encode('gradelens-history-v1\n' + new URL(origin).host + '\n' + account);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', identity));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function collectHistory(history, account, cache, options) {
  const keys = [app.preferencesKey, studentStorageKeys(new URL(origin).host, account).overrides];
  const stored = await chrome.storage.local.get(keys);
  const settings = app.normalizeSettings(stored[keys[0]]);
  if (!settings.enabled) return false;
  return app.observeHistory(history, cache, settings, stored[keys[1]], { at: Date.now(), ...options });
}

async function observeCommittedHistory(account, cache, options) {
  try {
    const history = await readLocalHistory(account);
    if (history.enabled && await collectHistory(history, account, cache, options)) {
      await chrome.storage.local.set({ [historyStorageKey(account)]: history });
      historyIssues.delete(account);
    }
  } catch {
    historyIssues.set(account, 'Grade history could not be saved. Your grade cache remains available.');
  }
}

async function historyOperation(account, message) {
  const history = await readLocalHistory(account);
  const key = historyStorageKey(account);
  switch (message.operation) {
    case 'get': return { ...history, issue: historyIssues.get(account) };
    case 'export': return app.archiveHistory(history);
    case 'enable': {
      if (typeof message.enabled !== 'boolean') throw new Error('Choose whether to track grades.');
      if (history.enabled === message.enabled) return history;
      history.enabled = message.enabled;
      if (history.enabled) {
        const now = Date.now();
        history.startedAt ??= now;
        const { cache } = await loadAccount(account);
        await collectHistory(history, account, cache, { at: now, reset: true });
        // Terms without an available cached grade start a separate segment when they return.
        for (const [scope, term] of Object.entries(history.terms)) {
          const live = cache.classes[term.classId]?.terms['term:' + term.termId];
          if (!live || app.historyKey(term.classId, live.termId) !== scope) term.checkpoint = null;
        }
      }
      break;
    }
    case 'clear':
      if (message.confirmed !== true) throw new Error('Confirm before clearing grade history.');
      if (message.classId === null) {
        history.terms = {};
        history.startedAt = history.enabled ? Date.now() : null;
      } else if (typeof message.classId === 'string' && /^\d{1,30}$/.test(message.classId)) {
        for (const [scope, term] of Object.entries(history.terms)) if (term.classId === message.classId) delete history.terms[scope];
      } else throw new Error('Select a subject to clear its history.');
      break;
    case 'settings': {
      if (history.enabled) {
        const { cache } = await loadAccount(account);
        await observeCommittedHistory(account, cache);
      }
      return null;
    }
    default: throw new Error('Unknown grade history action.');
  }
  await chrome.storage.local.set({ [key]: history });
  historyIssues.delete(account);
  return history;
}
