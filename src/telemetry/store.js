// IndexedDB-backed queue for telemetry events.
// Survives reloads and offline; the recorder writes here, the syncer drains
// from here to Supabase when online + opted-in.

const DB_NAME    = "inkk_telemetry";
const DB_VERSION = 1;
const STORE      = "events";

let dbPromise = null;

function openDb() {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("no-indexeddb"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("by_user_t", ["user_id", "t"]);
        os.createIndex("by_user_doc_t", ["user_id", "doc_id", "t"]);
        os.createIndex("by_t", "t");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
    req.onblocked = () => reject(new Error("idb-blocked"));
  });
  return dbPromise;
}

function tx(mode) {
  return openDb().then(db => {
    const t  = db.transaction(STORE, mode);
    const os = t.objectStore(STORE);
    return { os, done: new Promise((res, rej) => {
      t.oncomplete = () => res();
      t.onerror    = () => rej(t.error);
      t.onabort    = () => rej(t.error || new Error("tx-abort"));
    })};
  });
}

export async function enqueue(events) {
  if (!events?.length) return 0;
  try {
    const { os, done } = await tx("readwrite");
    for (const ev of events) os.put(ev);
    await done;
    return events.length;
  } catch {
    return 0;
  }
}

// Get up to `limit` oldest events for a specific user (so we don't accidentally
// upload events captured under a previous account).
export async function drain(userId, limit = 500) {
  if (!userId) return [];
  try {
    const { os } = await tx("readonly");
    return await new Promise((resolve, reject) => {
      const out = [];
      // Lower bound = [userId, 0], upper bound = [userId, +inf]
      const range = IDBKeyRange.bound([userId, 0], [userId, Number.MAX_SAFE_INTEGER]);
      const req = os.index("by_user_t").openCursor(range);
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur || out.length >= limit) { resolve(out); return; }
        out.push(cur.value);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function remove(ids) {
  if (!ids?.length) return 0;
  try {
    const { os, done } = await tx("readwrite");
    for (const id of ids) os.delete(id);
    await done;
    return ids.length;
  } catch {
    return 0;
  }
}

export async function countForUser(userId) {
  if (!userId) return 0;
  try {
    const { os } = await tx("readonly");
    return await new Promise((resolve, reject) => {
      const range = IDBKeyRange.bound([userId, 0], [userId, Number.MAX_SAFE_INTEGER]);
      const req = os.index("by_user_t").count(range);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  } catch {
    return 0;
  }
}

export async function dumpForUser(userId) {
  if (!userId) return [];
  try {
    const { os } = await tx("readonly");
    return await new Promise((resolve, reject) => {
      const out = [];
      const range = IDBKeyRange.bound([userId, 0], [userId, Number.MAX_SAFE_INTEGER]);
      const req = os.index("by_user_t").openCursor(range);
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) { resolve(out); return; }
        out.push(cur.value);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function clearForUser(userId) {
  if (!userId) return 0;
  try {
    const { os, done } = await tx("readwrite");
    const range = IDBKeyRange.bound([userId, 0], [userId, Number.MAX_SAFE_INTEGER]);
    let n = 0;
    await new Promise((resolve, reject) => {
      const req = os.index("by_user_t").openCursor(range);
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) { resolve(); return; }
        os.delete(cur.primaryKey); n++; cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    await done;
    return n;
  } catch {
    return 0;
  }
}

// Clear *all* events with no user_id (locally-recorded before sign-in, or guests).
export async function clearAnonymous() {
  try {
    const { os, done } = await tx("readwrite");
    await new Promise((resolve, reject) => {
      const req = os.openCursor();
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) { resolve(); return; }
        if (!cur.value.user_id) os.delete(cur.primaryKey);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    await done;
  } catch {}
}

// Reassign all anonymous events to a newly signed-in user, so they get synced.
export async function claimAnonymous(userId) {
  if (!userId) return 0;
  try {
    const { os, done } = await tx("readwrite");
    let n = 0;
    await new Promise((resolve, reject) => {
      const req = os.openCursor();
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) { resolve(); return; }
        if (!cur.value.user_id) {
          cur.update({ ...cur.value, user_id: userId });
          n++;
        }
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    await done;
    return n;
  } catch {
    return 0;
  }
}
