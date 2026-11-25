// Preference transfer uses the same serialized worker queue as other writes.
const restoreTickets = new Map();

const studentStorageKeys = (school, account) => ({
  overrides: 'mbgc:overrides:' + school + ':' + account,
  predictions: 'mbgc:predictions:' + school + ':' + account,
  goalPlans: 'mbgc:goal-plans:' + school + ':' + account
});

async function settingsTransfer(message, sender, account, school) {
  const { operation } = message;
  const caller = sender.documentId ?? sender.url + ':' + (sender.tab?.id ?? '');
  const keys = account ? studentStorageKeys(school, account) : null;
  const stored = await chrome.storage.local.get([app.preferencesKey, ...Object.values(keys ?? {})]);
  const settings = stored[app.preferencesKey];
  const student = keys ? {
    weights: stored[keys.overrides]?.weights ?? {}, scale: stored[keys.overrides]?.scale ?? null,
    predictions: stored[keys.predictions] ?? [], goalPlans: stored[keys.goalPlans] ?? []
  } : null;
  const scope = account ? app.scopeFromCache((await loadAccount(account)).cache) : {};
  if (operation === 'backup') {
    const file = app.makeBackup({ school, settings, student, scope });
    if (message.includeHistory === true && account) file.history = app.archiveHistory(await readLocalHistory(account), await historyOwner(account));
    return file;
  }

  const now = Date.now();
  for (const [token, ticket] of restoreTickets) if (ticket.expires < now) restoreTickets.delete(token);
  const baseline = JSON.stringify([settings, student, scope]);
  if (operation === 'preview') {
    const restore = app.prepareRestore(message.backup, { school, scope, settings, student });
    for (const [token, ticket] of restoreTickets) if (ticket.caller === caller) restoreTickets.delete(token);
    if (restoreTickets.size >= 20) restoreTickets.delete(restoreTickets.keys().next().value);
    const token = crypto.randomUUID();
    let archived;
    if (Object.hasOwn(message.backup, 'history')) {
      const incoming = app.readHistoryArchive(message.backup.history);
      if (account && message.backup.school.toLowerCase() === school && incoming.owner === await historyOwner(account)) {
        const history = await readLocalHistory(account);
        const merged = app.mergeHistory(history, incoming, scope);
        if (merged.added) archived = { baseline: JSON.stringify(history), history: merged.history };
        restore.preview.history = { added: merged.added, skipped: merged.skipped, full: merged.full, matched: true };
      } else restore.preview.history = { matched: false };
    }
    restoreTickets.set(token, { restore, account, caller, baseline, archived, expires: now + 10 * 60 * 1000 });
    return { token, ...restore.preview };
  }
  if (operation === 'restore') {
    const ticket = restoreTickets.get(message.token);
    if (!ticket || ticket.account !== account || ticket.caller !== caller || ticket.baseline !== baseline) {
      throw new Error('Settings or the active student changed, or the preview expired. Select the backup again to review it.');
    }
    const patch = { [app.preferencesKey]: ticket.restore.settings };
    const restored = ticket.restore.student;
    if (keys) {
      if (Object.hasOwn(restored, 'weights') || Object.hasOwn(restored, 'scale')) {
        patch[keys.overrides] = { weights: restored.weights ?? student.weights,
          scale: Object.hasOwn(restored, 'scale') ? restored.scale : student.scale };
      }
      for (const key of ['predictions', 'goalPlans']) if (Object.hasOwn(restored, key)) patch[keys[key]] = restored[key];
    }
    if (ticket.archived) {
      if (ticket.archived.baseline !== JSON.stringify(await readLocalHistory(account))) {
        throw new Error('Grade history changed after this preview. Select the backup again to review it.');
      }
      patch[historyStorageKey(account)] = ticket.archived.history;
    }
    await chrome.storage.local.set(patch);
    restoreTickets.delete(message.token);
    await app.refreshAppearancePrimer().catch(() => {});
    return { restored: true };
  }
  throw new Error('Unknown settings transfer action.');
}
