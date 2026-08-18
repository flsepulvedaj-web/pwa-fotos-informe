import { uuid } from './utils.js';

const DB_NAME = 'fotos-informe-db';
const DB_VERSION = 2;

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

      // Módulo Protocolos (v2): árbol completamente aparte del de fotos —
      // no son carpetas anidadas, son obras con protocolos adentro.
      if (!db.objectStoreNames.contains('obras')) {
        db.createObjectStore('obras', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('protocolInstances')) {
        const instances = db.createObjectStore('protocolInstances', { keyPath: 'id' });
        instances.createIndex('by_obraId', 'obraId', { unique: false });
      }

      if (!db.objectStoreNames.contains('protocolPhotos')) {
        const protocolPhotos = db.createObjectStore('protocolPhotos', { keyPath: 'id' });
        protocolPhotos.createIndex('by_instanceId', 'instanceId', { unique: false });
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

export async function createFolder(name, parentId = ROOT_ID, description = '') {
  const store = await tx('folders', 'readwrite');
  const folder = { id: uuid(), name, parentId, description, createdAt: Date.now() };
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

export async function updateFolder(id, changes) {
  const store = await tx('folders', 'readwrite');
  const folder = await wrap(store.get(id));
  if (!folder) return null;
  Object.assign(folder, changes);
  await wrap(store.put(folder));
  return folder;
}

export async function getAllFolders() {
  const result = [];
  async function walk(parentId, depth) {
    const children = await getChildFolders(parentId);
    for (const child of children) {
      result.push({ id: child.id, name: child.name, depth });
      await walk(child.id, depth + 1);
    }
  }
  await walk(ROOT_ID, 0);
  return result;
}

export async function getPinnedFolders() {
  const store = await tx('folders', 'readonly');
  const all = await wrap(store.getAll());
  return all.filter((f) => f.pinned).sort((a, b) => a.name.localeCompare(b.name, 'es'));
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

export async function addPhoto({ folderId, blob, title = '', note = '', syncStatus = null, driveFileId = null }) {
  const store = await tx('photos', 'readwrite');
  const photo = {
    id: uuid(),
    folderId,
    blob,
    title,
    note,
    createdAt: Date.now(),
    syncStatus,
    // Id del archivo en Drive cuando la foto llegó DESDE Drive (alguien la
    // subió directo ahí, sin pasar por la app) — sirve para no volver a
    // descargarla en cada sincronización ni tampoco volver a subirla.
    driveFileId,
  };
  await wrap(store.add(photo));
  return photo;
}

export async function getPendingUploads() {
  const store = await tx('photos', 'readonly');
  const all = await wrap(store.getAll());
  // 'error' se reintenta igual que 'pending' — antes una foto que fallaba
  // una vez (ej. porque la sesión de Google venció a mitad de la subida)
  // quedaba marcada como error para siempre, sin ningún reintento automático.
  return all
    .filter((p) => p.syncStatus === 'pending' || p.syncStatus === 'error')
    .sort((a, b) => a.createdAt - b.createdAt);
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

/**
 * Solo el número de fotos de una carpeta (sin traer las fotos completas —
 * más liviano para pintar el "tiene fotos" de varias carpetas a la vez en
 * la grilla, ej. las 50 casas de un loteo).
 */
export async function getPhotoCountByFolder(folderId) {
  const store = await tx('photos', 'readonly');
  const index = store.index('by_folderId');
  return wrap(index.count(folderId));
}

/**
 * Igual que getPhotoCountByFolder, pero sumando también las fotos de
 * todas las subcarpetas (en cualquier nivel) — para carpetas "madre" que
 * solo agrupan otras carpetas (ej. una torre con pisos y deptos adentro)
 * y no tienen fotos propias directas, así igual muestran cuánto avance
 * hay adentro de un vistazo.
 */
export async function getPhotoCountByFolderRecursive(folderId) {
  let total = await getPhotoCountByFolder(folderId);
  const children = await getChildFolders(folderId);
  const childCounts = await Promise.all(children.map((c) => getPhotoCountByFolderRecursive(c.id)));
  return total + childCounts.reduce((a, b) => a + b, 0);
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

export async function movePhotos(ids, targetFolderId) {
  for (const id of ids) {
    await updatePhoto(id, { folderId: targetFolderId });
  }
}

// ---------- Protocolos: obras ----------

export async function createObra(name) {
  const store = await tx('obras', 'readwrite');
  const obra = {
    id: uuid(),
    name,
    createdAt: Date.now(),
    driveObraFolderId: null,
    driveObraFolderName: null,
    planosDriveFolderId: null,
    planosDriveFolderName: null,
    signedDriveFolderId: null,
    signedDriveFolderName: null,
  };
  await wrap(store.add(obra));
  return obra;
}

export async function getObra(id) {
  const store = await tx('obras', 'readonly');
  return wrap(store.get(id));
}

export async function getAllObras() {
  const store = await tx('obras', 'readonly');
  const all = await wrap(store.getAll());
  return all.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export async function updateObra(id, changes) {
  const store = await tx('obras', 'readwrite');
  const obra = await wrap(store.get(id));
  if (!obra) return null;
  Object.assign(obra, changes);
  await wrap(store.put(obra));
  return obra;
}

export async function deleteObra(id) {
  const instances = await getInstancesByObra(id);
  for (const instance of instances) {
    await deleteProtocolInstance(instance.id);
  }
  const store = await tx('obras', 'readwrite');
  await wrap(store.delete(id));
}

// ---------- Protocolos: instancias ----------

export async function createProtocolInstance({ obraId, templateId, templateTitle, header, controlPoints }) {
  const store = await tx('protocolInstances', 'readwrite');
  const now = Date.now();
  const instance = {
    id: uuid(),
    obraId,
    templateId,
    templateTitle,
    status: 'draft', // 'draft' | 'emitted'
    createdAt: now,
    updatedAt: now,
    emittedAt: null,
    header: { obra: '', cliente: '', ubicacion: '', area: '', plano: '', sector: '', ...header },
    // Copia (snapshot) de los puntos de control del template al momento de
    // crear el protocolo — si más adelante se corrige un texto en
    // protocolTemplates.js, los borradores ya empezados no cambian solos.
    controlPoints: controlPoints.map((cp) => ({ label: cp.label, instruction: cp.instruction, status: null })),
    observaciones: '',
    plano: null, // { driveFileId, driveFileName, blob } | null
    signatures: {}, // { [roleId]: { nombre, fecha, signatureBlob } }
    pdfDriveFileId: null,
    pdfDriveFileName: null,
  };
  await wrap(store.add(instance));
  return instance;
}

export async function getProtocolInstance(id) {
  const store = await tx('protocolInstances', 'readonly');
  return wrap(store.get(id));
}

export async function getDraftInstances() {
  const store = await tx('protocolInstances', 'readonly');
  const all = await wrap(store.getAll());
  return all.filter((i) => i.status === 'draft').sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getInstancesByObra(obraId) {
  const store = await tx('protocolInstances', 'readonly');
  const index = store.index('by_obraId');
  const results = await wrap(index.getAll(obraId));
  return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function updateProtocolInstance(id, changes) {
  const store = await tx('protocolInstances', 'readwrite');
  const instance = await wrap(store.get(id));
  if (!instance) return null;
  Object.assign(instance, changes, { updatedAt: Date.now() });
  await wrap(store.put(instance));
  return instance;
}

export async function deleteProtocolInstance(id) {
  const photos = await getProtocolPhotosByInstance(id);
  for (const photo of photos) {
    await deleteProtocolPhoto(photo.id);
  }
  const store = await tx('protocolInstances', 'readwrite');
  await wrap(store.delete(id));
}

// ---------- Protocolos: fotos ----------

export async function addProtocolPhoto({ instanceId, blob }) {
  const store = await tx('protocolPhotos', 'readwrite');
  const photo = { id: uuid(), instanceId, blob, createdAt: Date.now() };
  await wrap(store.add(photo));
  return photo;
}

export async function getProtocolPhotosByInstance(instanceId) {
  const store = await tx('protocolPhotos', 'readonly');
  const index = store.index('by_instanceId');
  const results = await wrap(index.getAll(instanceId));
  return results.sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteProtocolPhoto(id) {
  const store = await tx('protocolPhotos', 'readwrite');
  await wrap(store.delete(id));
}
