const accountStates = new Map();
const journalSize = 32;
let database;

function databaseConnection() {
  database ??= new Promise((resolve, reject) => {
    const open = indexedDB.open('mbgc-verified-grades', 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('accounts');
      open.result.createObjectStore('classes', { keyPath: ['account', 'classId'] });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}

const requestValue = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const classRange = (account) => IDBKeyRange.bound([account, ''], [account, '\uffff']);
const withoutClasses = ({ classes, ...metadata }) => metadata;

async function saveAccount(account, cache, changed, clear = false) {
  const db = await databaseConnection();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(['accounts', 'classes'], 'readwrite');
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error('Grade cache transaction aborted.'));
    transaction.objectStore('accounts').put(withoutClasses(cache), account);
    const classes = transaction.objectStore('classes');
    if (clear) classes.delete(classRange(account));
    for (const classId of changed) classes.put({ account, classId, subject: cache.classes[classId] });
  });
}

async function loadAccount(account) {
  if (accountStates.has(account)) return accountStates.get(account);
  const db = await databaseConnection();
  const read = db.transaction(['accounts', 'classes'], 'readonly');
  const [metadata, classes] = await Promise.all([
    requestValue(read.objectStore('accounts').get(account)),
    requestValue(read.objectStore('classes').getAll(classRange(account)))
  ]);
  let cache = { ...app.freshCache(), ...metadata,
    classes: Object.fromEntries(classes.map(({ classId, subject }) => [classId, subject])) };
  if (!metadata) {
    const previousKey = 'mbgc:cache:uia.managebac.com:' + account;
    const old = (await chrome.storage.session.get(previousKey))[previousKey];
    if (old) {
      cache = { ...cache, ...old };
      await saveAccount(account, cache, Object.keys(cache.classes));
      await chrome.storage.session.remove(previousKey);
    }
  }
  const state = { cache, journal: [] };
  accountStates.set(account, state);
  return state;
}

function replyFor(state, since, epoch) {
  const cache = state.cache;
  if (epoch !== cache.clearedAt || !Number.isInteger(since) || since > cache.revision) return cache;
  if (since === cache.revision) return { revision: since, clearedAt: epoch, base: since, classes: {} };
  const from = state.journal.findIndex((entry) => entry.revision === since + 1);
  if (from < 0) return cache;
  const ids = new Set(state.journal.slice(from).flatMap((entry) => entry.changed));
  return { ...withoutClasses(cache), base: since,
    classes: Object.fromEntries([...ids].map((id) => [id, cache.classes[id]])) };
}

async function commitScans(account, state, snapshots, checks) {
  const before = state.cache;
  const ids = new Set();
  const committedAfter = (item) => !before.clearedAt || item.at > before.clearedAt;
  snapshots = snapshots.filter(committedAfter);
  checks = checks.filter(committedAfter);
  if (!snapshots.length && !checks.length) return false;
  for (const scan of snapshots) {
    if (scan.context.classId) ids.add(scan.context.classId);
    for (const [id, name] of Object.entries(scan.classes)) {
      if (!before.classes[id] || (name && before.classes[id].name !== name)) ids.add(id);
    }
    for (const task of scan.records) ids.add(task.classId);
  }
  for (const { classId } of checks) if (classId) ids.add(classId);
  const cache = { ...before, classes: { ...before.classes }, sourceChecks: { ...before.sourceChecks } };
  for (const id of ids) if (cache.classes[id]) cache.classes[id] = structuredClone(cache.classes[id]);
  for (const scan of snapshots) app.mergeScan(cache, scan);
  for (const check of checks) app.mergeCheck(cache, check);
  const changed = [];
  for (const id of ids) {
    if (JSON.stringify(cache.classes[id]) !== JSON.stringify(before.classes[id])) changed.push(id);
    else if (before.classes[id]) cache.classes[id] = before.classes[id];
  }
  if (!changed.length && JSON.stringify(withoutClasses(cache)) === JSON.stringify(withoutClasses(before))) return false;
  cache.revision++;
  await saveAccount(account, cache, changed);
  state.cache = cache;
  state.journal.push({ revision: cache.revision, changed });
  if (state.journal.length > journalSize) state.journal.shift();
  return true;
}
