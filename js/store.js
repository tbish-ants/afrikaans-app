// Tiny IndexedDB wrapper: key/value store, card states, review log.
const DB_NAME = 'afrikaans';
const DB_VERSION = 1;
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('log')) {
          const s = db.createObjectStore('log', { autoIncrement: true });
          s.createIndex('ts', 'ts');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const kv = {
  get: key => tx('kv', 'readonly', s => reqP(s.get(key))),
  set: (key, val) => tx('kv', 'readwrite', s => { s.put(val, key); }),
  del: key => tx('kv', 'readwrite', s => { s.delete(key); }),
};

export const cards = {
  all: () => tx('cards', 'readonly', s => reqP(s.getAll())),
  put: c => tx('cards', 'readwrite', s => { s.put(c); }),
  putMany: list => tx('cards', 'readwrite', s => { list.forEach(c => s.put(c)); }),
  clear: () => tx('cards', 'readwrite', s => { s.clear(); }),
};

export const log = {
  add: entry => tx('log', 'readwrite', s => { s.add(entry); }),
  all: () => tx('log', 'readonly', s => reqP(s.getAll())),
  since: ts => tx('log', 'readonly', s => reqP(s.index('ts').getAll(IDBKeyRange.lowerBound(ts)))),
  clear: () => tx('log', 'readwrite', s => { s.clear(); }),
  addMany: list => tx('log', 'readwrite', s => { list.forEach(e => s.add(e)); }),
};
