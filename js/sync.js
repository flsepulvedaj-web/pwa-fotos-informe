import { getPendingUploads, getFolder, getChildFolders, createFolder, updateFolder, updatePhoto } from './db.js';
import { uploadFile, listDriveFolders, createDriveFolder } from './googleDrive.js';

let syncing = false;
const listeners = new Set();

export function onSyncChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  listeners.forEach((fn) => fn());
}

function photoFilename(photo) {
  const d = new Date(photo.createdAt);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${photo.title ? photo.title.replace(/[\\/:*?"<>|]+/g, '-') + '-' : ''}${stamp}.jpg`;
}

/**
 * Sube a Drive todas las fotos pendientes de carpetas enlazadas. Se puede
 * llamar tantas veces como se quiera: si ya hay una sincronización en
 * curso, no se solapan.
 */
export async function trySync() {
  if (syncing) return;
  if (!navigator.onLine) return;
  syncing = true;
  try {
    const pending = await getPendingUploads();
    for (const photo of pending) {
      const folder = await getFolder(photo.folderId);
      if (!folder || !folder.driveFolderId) {
        // La carpeta se desenlazó de Drive mientras tanto: ya no aplica.
        await updatePhoto(photo.id, { syncStatus: null });
        notify();
        continue;
      }
      try {
        await uploadFile(folder.driveFolderId, photo.blob, photoFilename(photo));
        await updatePhoto(photo.id, { syncStatus: 'synced' });
      } catch (err) {
        console.error('Error subiendo foto a Drive:', err);
        await updatePhoto(photo.id, { syncStatus: 'error' });
      }
      notify();
    }
  } finally {
    syncing = false;
  }
}

/**
 * Revisa en Drive si dentro de la carpeta enlazada hay subcarpetas que
 * todavía no existen en la app (creadas directo en Drive por Pancho u otra
 * persona) y las crea localmente. Devuelve true si encontró alguna nueva.
 */
export async function syncFoldersFromDrive(folder) {
  if (!folder?.driveFolderId || !navigator.onLine) return { foundNew: false, error: null };
  try {
    const [driveChildren, localChildren] = await Promise.all([
      listDriveFolders(folder.driveFolderId),
      getChildFolders(folder.id),
    ]);
    const knownDriveIds = new Set(localChildren.map((f) => f.driveFolderId).filter(Boolean));
    let foundNew = false;
    for (const dc of driveChildren) {
      if (knownDriveIds.has(dc.id)) continue;
      const created = await createFolder(dc.name, folder.id, '');
      await updateFolder(created.id, { driveFolderId: dc.id, driveFolderName: dc.name });
      foundNew = true;
    }
    return { foundNew, error: null, driveChildrenCount: driveChildren.length };
  } catch (err) {
    console.error('Error sincronizando carpetas desde Drive:', err);
    return { foundNew: false, error: err.message || String(err) };
  }
}

/**
 * Si la carpeta enlazada lo permite, crea también en Drive una carpeta
 * recién creada en la app (para que la sincronización sea de ida y vuelta).
 */
export async function createMatchingDriveFolder(localFolder, parentFolder) {
  if (!parentFolder?.driveFolderId) return;
  try {
    const created = await createDriveFolder(parentFolder.driveFolderId, localFolder.name);
    await updateFolder(localFolder.id, { driveFolderId: created.id, driveFolderName: created.name });
  } catch (err) {
    console.error('Error creando la carpeta en Drive:', err);
  }
}

export function initSync() {
  window.addEventListener('online', () => trySync());
  if (navigator.onLine) trySync();
}
