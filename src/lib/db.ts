import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Account, DownloadEntry, LocalPosition, PendingOp } from './types';

interface PinepodsDB extends DBSchema {
  accounts: {
    key: string;
    value: Account;
  };
  /** Generic per-account API response cache. Key: `${accountId}:${cacheKey}` */
  cache: {
    key: string;
    value: { key: string; accountId: string; data: unknown; updatedAt: number };
    indexes: { byAccount: string };
  };
  positions: {
    key: string;
    value: LocalPosition;
    indexes: { byAccount: string };
  };
  downloads: {
    key: string;
    value: DownloadEntry;
    indexes: { byAccount: string };
  };
  /** Audio blobs, same key as the downloads entry. Kept separate so listing
   * downloads doesn't pull megabytes of audio into memory. */
  downloadBlobs: {
    key: string;
    value: { key: string; blob: Blob };
  };
  pendingOps: {
    key: number;
    value: PendingOp;
    indexes: { byAccount: string };
  };
}

let dbPromise: Promise<IDBPDatabase<PinepodsDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<PinepodsDB>> {
  if (!dbPromise) {
    dbPromise = openDB<PinepodsDB>('pinepods-offline', 1, {
      upgrade(db) {
        db.createObjectStore('accounts', { keyPath: 'id' });
        const cache = db.createObjectStore('cache', { keyPath: 'key' });
        cache.createIndex('byAccount', 'accountId');
        const positions = db.createObjectStore('positions', { keyPath: 'key' });
        positions.createIndex('byAccount', 'accountId');
        const downloads = db.createObjectStore('downloads', { keyPath: 'key' });
        downloads.createIndex('byAccount', 'accountId');
        db.createObjectStore('downloadBlobs', { keyPath: 'key' });
        const ops = db.createObjectStore('pendingOps', { keyPath: 'id', autoIncrement: true });
        ops.createIndex('byAccount', 'accountId');
      },
    });
  }
  return dbPromise;
}

// ---- cache helpers -------------------------------------------------------

export async function cacheGet<T>(accountId: string, key: string): Promise<T | undefined> {
  const db = await getDB();
  const row = await db.get('cache', `${accountId}:${key}`);
  return row?.data as T | undefined;
}

export async function cacheSet(accountId: string, key: string, data: unknown): Promise<void> {
  const db = await getDB();
  await db.put('cache', { key: `${accountId}:${key}`, accountId, data, updatedAt: Date.now() });
}

// ---- positions -----------------------------------------------------------

export async function getLocalPosition(
  accountId: string,
  episodeId: number,
): Promise<LocalPosition | undefined> {
  const db = await getDB();
  return db.get('positions', `${accountId}:${episodeId}`);
}

export async function putLocalPosition(pos: LocalPosition): Promise<void> {
  const db = await getDB();
  await db.put('positions', pos);
}

// ---- downloads -----------------------------------------------------------

export async function listDownloads(accountId: string): Promise<DownloadEntry[]> {
  const db = await getDB();
  const rows = await db.getAllFromIndex('downloads', 'byAccount', accountId);
  return rows.sort((a, b) => b.downloadedAt - a.downloadedAt);
}

export async function getDownload(
  accountId: string,
  episodeId: number,
): Promise<DownloadEntry | undefined> {
  const db = await getDB();
  return db.get('downloads', `${accountId}:${episodeId}`);
}

export async function getDownloadBlob(
  accountId: string,
  episodeId: number,
): Promise<Blob | undefined> {
  const db = await getDB();
  const row = await db.get('downloadBlobs', `${accountId}:${episodeId}`);
  return row?.blob;
}

export async function putDownload(entry: DownloadEntry, blob: Blob): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['downloads', 'downloadBlobs'], 'readwrite');
  await tx.objectStore('downloads').put(entry);
  await tx.objectStore('downloadBlobs').put({ key: entry.key, blob });
  await tx.done;
}

export async function deleteDownload(accountId: string, episodeId: number): Promise<void> {
  const db = await getDB();
  const key = `${accountId}:${episodeId}`;
  const tx = db.transaction(['downloads', 'downloadBlobs'], 'readwrite');
  await tx.objectStore('downloads').delete(key);
  await tx.objectStore('downloadBlobs').delete(key);
  await tx.done;
}

// ---- pending ops ---------------------------------------------------------

export async function queueOp(op: PendingOp): Promise<void> {
  const db = await getDB();
  await db.add('pendingOps', op);
}

export async function listOps(accountId: string): Promise<PendingOp[]> {
  const db = await getDB();
  return db.getAllFromIndex('pendingOps', 'byAccount', accountId);
}

export async function deleteOp(id: number): Promise<void> {
  const db = await getDB();
  await db.delete('pendingOps', id);
}

// ---- accounts ------------------------------------------------------------

export async function listAccounts(): Promise<Account[]> {
  const db = await getDB();
  const accounts = await db.getAll('accounts');
  return accounts.sort((a, b) => a.addedAt - b.addedAt);
}

export async function putAccount(account: Account): Promise<void> {
  const db = await getDB();
  await db.put('accounts', account);
}

/** Remove an account and every piece of data cached for it. */
export async function removeAccount(accountId: string): Promise<void> {
  const db = await getDB();
  await db.delete('accounts', accountId);
  for (const store of ['cache', 'positions', 'downloads', 'pendingOps'] as const) {
    const keys = await db.getAllKeysFromIndex(store, 'byAccount', accountId);
    const tx = db.transaction(store, 'readwrite');
    for (const key of keys) await tx.store.delete(key as never);
    await tx.done;
  }
  // downloadBlobs has no account index; sweep by key prefix.
  const blobKeys = (await db.getAllKeys('downloadBlobs')).filter((k) =>
    String(k).startsWith(`${accountId}:`),
  );
  const tx = db.transaction('downloadBlobs', 'readwrite');
  for (const key of blobKeys) await tx.store.delete(key);
  await tx.done;
}
