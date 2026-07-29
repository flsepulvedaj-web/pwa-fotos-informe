import { uuid } from './utils.js';

const DB_NAME = 'fotos-informe-db';
const DB_VERSION = 1;

// IndexedDB no permite `null`/`undefined` como clave de índice: los registros
// con ese valor simplemente no se indexan. Usamos '' como id de la carpeta
// raíz para que las consultas por índice (by_parentId, by_folderId) funcionen.
export const ROOT_ID = '';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;

      if (!db.objectStoreNames.contains('folders')) {
        const folders = db.createObjectStore('folders', { keyPath: 'id' });
        folders.createIndex('by_parentId', 'parentId', { unique: false });
      }

      if (!db.objectStoreNames.contains('photos')) {
        const photos = db.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('by_folderId', 'folderId', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------- Folders ----------

export async function createFolder(name, parentId = ROOT_ID) {
  const store = await tx('folders', 'readwrite');
  const folder = { id: uuid(), name, parentId, createdAt: Date.now() };
  await wrap(store.add(folder));
  return folder;
}

export async function getFolder(id) {
  const store = await tx('folders', 'readonly');
  return wrap(store.get(id));
}

export async function getChildFolders(parentId = ROOT_ID) {
  const store = await tx('folders', 'readonly');
  const index = store.index('by_parentId');
  const results = await wrap(index.getAll(parentId));
  return results.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export async function renameFolder(id, name) {
  const store = await tx('folders', 'readwrite');
  const folder = await wrap(store.get(id));
  if (!folder) return null;
  folder.name = name;
  await wrap(store.put(folder));
  return folder;
}

export async function deleteFolderRecursive(id) {
  const children = await getChildFolders(id);
  for (const child of children) {
    await deleteFolderRecursive(child.id);
  }
  const photos = await getPhotosByFolder(id);
  for (const photo of photos) {
    await deletePhoto(photo.id);
  }
  const store = await tx('folders', 'readwrite');
  await wrap(store.delete(id));
}

export async function getFolderPath(id) {
  const path = [];
  let current = id;
  while (current) {
    const folder = await getFolder(current);
    if (!folder) break;
    path.unshift(folder);
    current = folder.parentId;
  }
  return path;
}

// ---------- Photos ----------

export async function addPhoto({ folderId, blob, title = '', note = '' }) {
  const store = await tx('photos', 'readwrite');
  const photo = {
    id: uuid(),
    folderId,
    blob,
    title,
    note,
    createdAt: Date.now(),
  };
  await wrap(store.add(photo));
  return photo;
}

export async function getPhoto(id) {
  const store = await tx('photos', 'readonly');
  return wrap(store.get(id));
}

export async function getPhotosByFolder(folderId) {
  const store = await tx('photos', 'readonly');
  const index = store.index('by_folderId');
  const results = await wrap(index.getAll(folderId));
  return results.sort((a, b) => a.createdAt - b.createdAt);
}

export async function updatePhoto(id, changes) {
  const store = await tx('photos', 'readwrite');
  const photo = await wrap(store.get(id));
  if (!photo) return null;
  Object.assign(photo, changes);
  await wrap(store.put(photo));
  return photo;
}

export async function deletePhoto(id) {
  const store = await tx('photos', 'readwrite');
  await wrap(store.delete(id));
}

export async function getPhotosByIds(ids) {
  const photos = await Promise.all(ids.map((id) => getPhoto(id)));
  return photos.filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
}
