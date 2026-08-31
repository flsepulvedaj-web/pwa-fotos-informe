// Sincroniza la LISTA de obras (no sus datos de Personal/Checklist/Avance,
// eso ya lo hace controlSync.js) entre los teléfonos del equipo — sin
// esto, cada persona tenía que crear sus propias obras a mano y nunca
// coincidían con las de los demás (los ids de obra eran solo locales).
//
// Un único archivo compartido en Drive (obras-index.json, en la misma
// carpeta raíz que ya usa todo el equipo) con `{ obras, deletedIds }`. Se
// sobreescribe entero en cada guardado (como permissions.json) — las obras
// son pocas, no hace falta el esquema de "un archivo por registro" que sí
// usa controlSync.js para los registros diarios.
//
// `deletedIds` (tumbas) existe porque el resto de este archivo es
// puramente ADITIVO: sin esto, borrar una obra duplicada en un teléfono
// nunca le llegaba a los demás (cada uno se quedaba con su copia local
// para siempre, ya que sincronizar solo agrega/actualiza, nunca borra algo
// que el teléfono ya tenía). Cualquier id que aparezca en `deletedIds` se
// borra localmente (obra + todo lo que cuelga de ella) apenas se ve, sin
// importar si además viene en `obras` de un archivo viejo con el que se
// cruzó por una carrera de guardados.
import { DEFAULT_ROOT_FOLDER, findFileByName, updateFileContent, uploadFile, downloadDriveFile } from './googleDrive.js';
import { getAllObras, upsertObra, getObra, deleteObra, addObraTombstone, getObraTombstoneIds } from './db.js';

const FILE_NAME = 'obras-index.json';

/** Sube (best-effort) la lista completa de obras + las tumbas locales a Drive. */
export async function uploadObrasIndex() {
  try {
    const [obras, deletedIds] = await Promise.all([getAllObras(), getObraTombstoneIds()]);
    const blob = new Blob([JSON.stringify({ obras, deletedIds })], { type: 'application/json' });
    const existing = await findFileByName(DEFAULT_ROOT_FOLDER.id, FILE_NAME);
    if (existing) {
      await updateFileContent(existing.id, blob);
    } else {
      await uploadFile(DEFAULT_ROOT_FOLDER.id, blob, FILE_NAME);
    }
    return true;
  } catch (err) {
    console.error('No se pudo subir la lista de obras a Drive:', err);
    return false;
  }
}

/**
 * Borra una obra (en cascada, con todo lo que cuelga de ella) y avisa al
 * resto del equipo: agrega una tumba local y sube el índice altiro — así no
 * hay que esperar a que alguien más abra Control para que se entere.
 */
export async function deleteObraEverywhere(obraId) {
  await deleteObra(obraId);
  await addObraTombstone(obraId);
  await uploadObrasIndex(); // best-effort, no bloquea
}

/** Trae de Drive las obras nuevas o más recientes que las locales (mismo id,
 * "último write gana" por updatedAt) y aplica las tumbas que haya. Devuelve
 * cuántas obras cambiaron (nuevas/actualizadas + borradas por tumba). */
export async function syncObrasFromDrive() {
  const file = await findFileByName(DEFAULT_ROOT_FOLDER.id, FILE_NAME);
  if (!file) return 0;
  const blob = await downloadDriveFile(file.id);
  const raw = JSON.parse(await blob.text());
  // Compatibilidad con el formato viejo (un array plano, sin tumbas).
  const remoteObras = Array.isArray(raw) ? raw : (raw.obras || []);
  const remoteDeletedIds = Array.isArray(raw) ? [] : (raw.deletedIds || []);

  let changed = 0;

  // 1. Tumbas primero — si una obra está marcada borrada, ni se molesta en
  // mergearla más abajo aunque también venga en `remoteObras` (puede pasar
  // si el archivo quedó armado de una carrera entre 2 guardados).
  const localTombstones = new Set(await getObraTombstoneIds());
  for (const deadId of remoteDeletedIds) {
    if (localTombstones.has(deadId)) continue; // ya se aplicó antes en este teléfono
    const local = await getObra(deadId);
    if (local) {
      await deleteObra(deadId);
      changed++;
    }
    await addObraTombstone(deadId);
    localTombstones.add(deadId);
  }

  // 2. Merge normal de obras vivas.
  //
  // OJO con esto: no se puede simplemente "reemplazar entero" el registro
  // local por el remoto aunque sea más nuevo (`remote.updatedAt` mayor).
  // Cada obra tiene ~10 campos de vinculación de Drive, uno por módulo
  // (driveObraFolderId de Protocolos, checklistDriveFolderId de Control,
  // costosDriveFolderId de Costos, etc.) — si Pancho vincula Drive en
  // Costos desde su teléfono, y ANTES de que le llegue ese cambio al
  // teléfono de Sergio, Sergio guarda cualquier cosa sin relación (lo que
  // sea que actualice el registro de la obra), su versión local — que
  // nunca tuvo `costosDriveFolderId` porque a él nunca le llegó — queda
  // con un `updatedAt` más nuevo y "gana" el reemplazo, BORRANDO sin
  // querer la vinculación que Pancho acababa de hacer para todo el equipo.
  // Esto pasó de verdad (Sergio no podía vincular Drive en ningún módulo).
  // Por eso se fusiona campo por campo: un campo vacío/ausente en el
  // remoto NUNCA borra uno que el teléfono local ya tenía. El único costo
  // es que "desvincular" una carpeta (ponerla en null a propósito) no se
  // propaga sola a los demás — aceptable, es rarísimo, contra perder datos
  // de verdad como pasó hoy.
  const localObras = await getAllObras();
  const localById = new Map(localObras.map((o) => [o.id, o]));
  for (const remote of remoteObras) {
    if (localTombstones.has(remote.id)) continue;
    const local = localById.get(remote.id);
    if (!local) {
      await upsertObra(remote);
      changed++;
      continue;
    }
    if ((remote.updatedAt || 0) > (local.updatedAt || 0)) {
      const merged = { ...remote };
      for (const key of Object.keys(local)) {
        if ((remote[key] === undefined || remote[key] === null) && local[key] != null) {
          merged[key] = local[key];
        }
      }
      await upsertObra(merged);
      changed++;
    }
  }
  return changed;
}
