const DB_NAME = "aimenu-v2-image-cache";
const STORE_NAME = "dish-images";
const DB_VERSION = 1;

type CachedImageRecord = {
  key: string;
  blob: Blob;
  updatedAt: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });

  return dbPromise;
}

export async function getCachedDishImageBlob(cacheKey: string): Promise<Blob | null> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(cacheKey);

    request.onsuccess = () => {
      const record = request.result as CachedImageRecord | undefined;
      resolve(record?.blob || null);
    };
    request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
  });
}

export async function setCachedDishImageBlob(cacheKey: string, blob: Blob): Promise<void> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      key: cacheKey,
      blob,
      updatedAt: Date.now(),
    } satisfies CachedImageRecord);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("IndexedDB write failed"));
  });
}
