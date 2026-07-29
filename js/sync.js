import { getPendingUploads, getFolder, updatePhoto } from './db.js';
import { uploadFile } from './googleDrive.js';

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

export function initSync() {
  window.addEventListener('online', () => trySync());
  if (navigator.onLine) trySync();
}
