import { getPendingUploads, getFolder, getChildFolders, createFolder, updateFolder, updatePhoto, getPhotosByFolder, addPhoto, deleteFolderRecursive } from './db.js';
import { uploadFile, listDriveFolders, createDriveFolder, listDriveFiles, downloadDriveFile } from './googleDrive.js';

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
 * ¿Esta carpeta o alguna de sus subcarpetas tiene fotos que todavía no se
 * terminaron de subir a Drive? Se usa antes de borrar algo automáticamente
 * por haber desaparecido en Drive — si la respuesta es sí, NUNCA se borra
 * (se perdería la única copia que queda de esas fotos).
 */
async function hasUnsyncedPhotosRecursive(folderId) {
  const photos = await getPhotosByFolder(folderId);
  if (photos.some((p) => p.syncStatus === 'pending' || p.syncStatus === 'error')) return true;
  const children = await getChildFolders(folderId);
  for (const child of children) {
    if (await hasUnsyncedPhotosRecursive(child.id)) return true;
  }
  return false;
}

/**
 * Revisa en Drive si dentro de la carpeta enlazada hay subcarpetas que
 * todavía no existen en la app (creadas directo en Drive por Pancho u otra
 * persona) y las crea localmente. También refleja los borrados: Drive manda
 * — si una carpeta que antes estaba enlazada ya no existe en Drive, se
 * borra también acá, EXCEPTO si todavía tiene fotos sin subir (ahí nunca se
 * borra sola: se desenlaza de Drive nomás, para no perder esas fotos).
 */
export async function syncFoldersFromDrive(folder) {
  if (!folder?.driveFolderId || !navigator.onLine) return { foundNew: false, newCount: 0, deletedCount: 0, keptCount: 0, error: null };
  try {
    const [driveChildren, localChildren] = await Promise.all([
      listDriveFolders(folder.driveFolderId),
      getChildFolders(folder.id),
    ]);
    const driveIds = new Set(driveChildren.map((f) => f.id));
    const knownDriveIds = new Set(localChildren.map((f) => f.driveFolderId).filter(Boolean));
    let newCount = 0;
    for (const dc of driveChildren) {
      if (knownDriveIds.has(dc.id)) continue;
      const created = await createFolder(dc.name, folder.id, '');
      await updateFolder(created.id, { driveFolderId: dc.id, driveFolderName: dc.name });
      newCount++;
    }

    let deletedCount = 0;
    let keptCount = 0;
    for (const lc of localChildren) {
      if (!lc.driveFolderId || driveIds.has(lc.driveFolderId)) continue; // sigue existiendo en Drive, no se toca
      const unsafe = await hasUnsyncedPhotosRecursive(lc.id);
      if (unsafe) {
        // Tiene fotos que no alcanzaron a subir: se desenlaza de Drive (para
        // no seguir comparando contra una carpeta que ya no existe) pero el
        // contenido local queda intacto, nunca se borra.
        await updateFolder(lc.id, { driveFolderId: null, driveFolderName: null });
        keptCount++;
      } else {
        await deleteFolderRecursive(lc.id);
        deletedCount++;
      }
    }

    return { foundNew: newCount > 0, newCount, deletedCount, keptCount, error: null, driveChildrenCount: driveChildren.length };
  } catch (err) {
    console.error('Error sincronizando carpetas desde Drive:', err);
    return { foundNew: false, newCount: 0, deletedCount: 0, keptCount: 0, error: err.message || String(err) };
  }
}

/**
 * Trae a la app las fotos que se hayan subido directo en Drive, sin pasar
 * por la app (ej. copiadas a mano desde el computador). Quedan marcadas
 * 'synced' de entrada, porque ya están en Drive — así no se vuelven a
 * subir solas. Se guarda el driveFileId de cada una para no descargarla de
 * nuevo la próxima vez.
 */
export async function syncPhotosFromDrive(folder) {
  if (!folder?.driveFolderId || !navigator.onLine) return { downloaded: 0, error: null };
  try {
    const [driveFiles, localPhotos] = await Promise.all([
      listDriveFiles(folder.driveFolderId),
      getPhotosByFolder(folder.id),
    ]);
    const knownDriveFileIds = new Set(localPhotos.map((p) => p.driveFileId).filter(Boolean));
    let downloaded = 0;
    for (const file of driveFiles) {
      if (knownDriveFileIds.has(file.id)) continue;
      try {
        const blob = await downloadDriveFile(file.id);
        await addPhoto({ folderId: folder.id, blob, title: '', note: '', syncStatus: 'synced', driveFileId: file.id });
        downloaded++;
      } catch (err) {
        console.error(`Error descargando "${file.name}" de Drive:`, err);
      }
    }
    return { downloaded, error: null };
  } catch (err) {
    console.error('Error trayendo fotos desde Drive:', err);
    return { downloaded: 0, error: err.message || String(err) };
  }
}

/**
 * Igual que syncFoldersFromDrive + syncPhotosFromDrive, pero para TODA la
 * rama (recursivo): al entrar a "Calle 3" también revisa "4", "12", "9",
 * etc. sin tener que abrir cada una a mano — Pancho lo pidió así para ver
 * de un vistazo cómo va el equipo en terreno (tiene datos ilimitados, así
 * que el gasto de datos no es problema acá).
 */
export async function syncDriveTreeRecursive(folder) {
  const totals = { newCount: 0, deletedCount: 0, keptCount: 0, downloaded: 0, error: null };
  if (!folder?.driveFolderId || !navigator.onLine) return totals;

  async function walk(f) {
    const [folderResult, photoResult] = await Promise.all([syncFoldersFromDrive(f), syncPhotosFromDrive(f)]);
    totals.newCount += folderResult.newCount;
    totals.deletedCount += folderResult.deletedCount;
    totals.keptCount += folderResult.keptCount;
    totals.downloaded += photoResult.downloaded;
    if (folderResult.error) totals.error = folderResult.error;
    if (photoResult.error) totals.error = photoResult.error;

    // Sigue bajando por las subcarpetas enlazadas (las recién creadas
    // arriba también quedan incluidas, porque se leen de nuevo acá).
    const children = await getChildFolders(f.id);
    for (const child of children) {
      if (child.driveFolderId) await walk(child);
    }
  }

  await walk(folder);
  return totals;
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
