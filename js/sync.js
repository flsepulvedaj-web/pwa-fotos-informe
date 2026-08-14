import { ROOT_ID, getPendingUploads, getFolder, getChildFolders, createFolder, updateFolder, updatePhoto, getPhotosByFolder, addPhoto, deletePhoto, deleteFolderRecursive } from './db.js';
import { uploadFile, listDriveFolders, createDriveFolder, listDriveFiles, downloadDriveFile, isSignedIn } from './googleDrive.js';

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
  // Nunca se intenta subir en segundo plano si la sesión de Google ya no
  // está vigente: pedir una nueva acá (sin que Pancho haya hecho clic en
  // nada) hace que el navegador muestre la ventanita de conexión sola, una
  // y otra vez. Mejor dejar las fotos en 'pending' — el aviso de "Reintentar"
  // en foldersView.js ya detecta esto y solo ahí, con un clic real, se
  // vuelve a pedir sesión.
  if (!isSignedIn()) return;
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
        // Guardar el id del archivo recién creado en Drive es clave: sin
        // esto, la sincronización de fotos "traídas desde Drive" nunca
        // reconocía esta foto como propia y la volvía a descargar como si
        // fuera nueva cada vez que se abría la carpeta — duplicándola.
        const uploaded = await uploadFile(folder.driveFolderId, photo.blob, photoFilename(photo));
        await updatePhoto(photo.id, { syncStatus: 'synced', driveFileId: uploaded.id });
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

const RECOVERED_FOLDER_NAME = 'Recuperadas de Drive';

/**
 * Junta (recursivamente) las fotos de una carpeta y sus subcarpetas que
 * todavía no se terminaron de subir a Drive. Se usa justo antes de borrar
 * una carpeta que desapareció en Drive: esas fotos puntuales se rescatan
 * primero (ver getOrCreateRecoveredFolder) para que borrar la carpeta
 * nunca destruya la única copia que queda de ellas.
 */
async function collectUnsyncedPhotosRecursive(folderId, acc = []) {
  const photos = await getPhotosByFolder(folderId);
  for (const p of photos) {
    if (p.syncStatus === 'pending' || p.syncStatus === 'error') acc.push(p);
  }
  const children = await getChildFolders(folderId);
  for (const child of children) {
    await collectUnsyncedPhotosRecursive(child.id, acc);
  }
  return acc;
}

/** Carpeta de "red de seguridad" en el Inicio, se crea sola la primera vez que hace falta. */
async function getOrCreateRecoveredFolder() {
  const roots = await getChildFolders(ROOT_ID);
  const existing = roots.find((f) => f.name === RECOVERED_FOLDER_NAME);
  if (existing) return existing;
  return createFolder(
    RECOVERED_FOLDER_NAME,
    ROOT_ID,
    'Fotos que no alcanzaron a subirse a Drive antes de que se borrara la carpeta original ahí — revísalas y muévelas a donde correspondan.'
  );
}

/**
 * Revisa en Drive si dentro de la carpeta enlazada hay subcarpetas que
 * todavía no existen en la app (creadas directo en Drive por Pancho u otra
 * persona) y las crea localmente. También refleja los borrados: Drive
 * manda — si una carpeta que antes estaba enlazada ya no existe en Drive,
 * se borra también acá (Pancho: "si borro algo del Drive es porque ya no
 * lo necesito"). Antes de borrar, si le quedaban fotos que no alcanzaron a
 * subirse, esas fotos puntuales se rescatan a la carpeta "Recuperadas de
 * Drive" — así nunca se destruye la única copia de una foto por accidente,
 * pero la carpeta original siempre desaparece de la app tal como en Drive.
 */
export async function syncFoldersFromDrive(folder) {
  // Igual que en trySync(): si la sesión de Google venció, no se pide una
  // nueva sola — eso es lo que le mostraba a Pancho la ventanita de Google
  // cada vez que abría una carpeta. Se espera a que él haga clic en
  // "Reintentar" (un gesto real del usuario).
  if (!folder?.driveFolderId || !navigator.onLine || !isSignedIn()) {
    return { foundNew: false, newCount: 0, deletedCount: 0, recoveredCount: 0, error: null };
  }
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
    let recoveredCount = 0;
    for (const lc of localChildren) {
      if (!lc.driveFolderId || driveIds.has(lc.driveFolderId)) continue; // sigue existiendo en Drive, no se toca
      const unsynced = await collectUnsyncedPhotosRecursive(lc.id);
      if (unsynced.length) {
        const recovered = await getOrCreateRecoveredFolder();
        for (const p of unsynced) {
          await updatePhoto(p.id, { folderId: recovered.id, syncStatus: null });
        }
        recoveredCount += unsynced.length;
      }
      await deleteFolderRecursive(lc.id);
      deletedCount++;
    }

    return { foundNew: newCount > 0, newCount, deletedCount, recoveredCount, error: null, driveChildrenCount: driveChildren.length };
  } catch (err) {
    console.error('Error sincronizando carpetas desde Drive:', err);
    return { foundNew: false, newCount: 0, deletedCount: 0, recoveredCount: 0, error: err.message || String(err) };
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
  if (!folder?.driveFolderId || !navigator.onLine || !isSignedIn()) return { downloaded: 0, error: null };
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
let treeSyncing = false;

export async function syncDriveTreeRecursive(folder) {
  const totals = { newCount: 0, deletedCount: 0, recoveredCount: 0, downloaded: 0, error: null };
  if (!folder?.driveFolderId || !navigator.onLine || !isSignedIn()) return totals;
  // Si Pancho entra y sale rápido de varias carpetas, cada apertura dispara
  // esta sincronización — sin este seguro, dos pasadas podían solaparse,
  // leer el mismo estado "todavía no bajada" antes de que la primera
  // terminara de guardar, y descargar la misma foto de Drive dos veces.
  if (treeSyncing) return totals;
  treeSyncing = true;

  async function walk(f) {
    const [folderResult, photoResult] = await Promise.all([syncFoldersFromDrive(f), syncPhotosFromDrive(f)]);
    totals.newCount += folderResult.newCount;
    totals.deletedCount += folderResult.deletedCount;
    totals.recoveredCount += folderResult.recoveredCount;
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

  try {
    await walk(folder);
  } finally {
    treeSyncing = false;
  }
  return totals;
}

/**
 * Quita fotos duplicadas de una carpeta y sus subcarpetas (recursivo) —
 * quedaron así por un bug ya arreglado (varias descargas de la misma foto
 * de Drive antes de que la primera terminara de guardarse). Dos fotos
 * cuentan como duplicadas solo si comparten el mismo driveFileId — nunca
 * se tocan las fotos sin ese dato (todas las tomadas con la cámara antes
 * de este arreglo), para no arriesgar borrar algo real por error. Devuelve
 * cuántas se quitaron.
 */
export async function deduplicatePhotosRecursive(folderId) {
  let removed = 0;
  async function processFolder(id) {
    const photos = await getPhotosByFolder(id);
    const seen = new Set();
    for (const p of photos) {
      if (!p.driveFileId) continue;
      if (seen.has(p.driveFileId)) {
        await deletePhoto(p.id);
        removed++;
      } else {
        seen.add(p.driveFileId);
      }
    }
    const children = await getChildFolders(id);
    for (const child of children) {
      await processFolder(child.id);
    }
  }
  await processFolder(folderId);
  return removed;
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
