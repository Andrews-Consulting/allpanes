// Captures are handed from the service worker to the result page through IndexedDB: an image can be
// tens of megabytes, which is past what chrome.storage.session holds, and IndexedDB stores the Blob
// as-is. The newest few are kept so reloading a result tab still works.

const DB_NAME = "allpanes";
const STORE = "captures";
const KEEP = 10;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const settled = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export async function putCapture(record) {
  const db = await openDb();
  // Leading timestamp, so sorting the keys as strings sorts them oldest first.
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  store.put({ ...record, id });
  const keys = (await settled(store.getAllKeys())).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - KEEP))) store.delete(key);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return id;
}

export async function getCapture(id) {
  const db = await openDb();
  const record = await settled(db.transaction(STORE).objectStore(STORE).get(id));
  db.close();
  return record;
}
