// Sincroniza la LISTA de obras (no sus datos de Personal/Checklist/Avance,
// eso ya lo hace controlSync.js) entre los teléfonos del equipo — sin
// esto, cada persona tenía que crear sus propias obras a mano y nunca
// coincidían con las de los demás (los ids de obra eran solo locales).
//
// Un único archivo compartido en Drive (obras-index.json, en la misma
// carpeta raíz que ya usa todo el equipo) con la lista completa de obras.
// Se sobreescribe entero en cada guardado (como permissions.json) — las
// obras son pocas, no hace falta el esquema de "un archivo por registro"
// que sí usa controlSync.js para los registros diarios.
import { DEFAULT_ROOT_FOLDER, findFileByName, updateFileContent, uploadFile, downloadDriveFile } from './googleDrive.js';
import { getAllObras, upsertObra } from './db.js';

const FILE_NAME = 'obras-index.json';

/** Sube (best-effort) la lista completa de obras a Drive. */
export async function uploadObrasIndex() {
  try {
    const obras = await getAllObras();
    const blob = new Blob([JSON.stringify(obras)], { type: 'application/json' });
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

/** Trae de Drive las obras nuevas o más recientes que las locales (mismo id,
 * "último write gana" por updatedAt). Devuelve cuántas cambiaron. */
export async function syncObrasFromDrive() {
  const file = await findFileByName(DEFAULT_ROOT_FOLDER.id, FILE_NAME);
  if (!file) return 0;
  const blob = await downloadDriveFile(file.id);
  const remoteObras = JSON.parse(await blob.text());
  const localObras = await getAllObras();
  const localById = new Map(localObras.map((o) => [o.id, o]));

  let changed = 0;
  for (const remote of remoteObras) {
    const local = localById.get(remote.id);
    if (!local || (remote.updatedAt || 0) > (local.updatedAt || 0)) {
      await upsertObra(remote);
      changed++;
    }
  }
  return changed;
}
