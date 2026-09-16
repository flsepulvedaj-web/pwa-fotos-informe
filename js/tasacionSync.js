// Respaldo en Drive del módulo Estudio de mercado — carpeta propia
// "ESTUDIO DE MERCADO" en la raíz compartida (misma que ya usa el resto de
// la app), con una subcarpeta por tasación (AO + nombre del proyecto).
// Cada subcarpeta tiene "datos.json" (el estudio completo, para poder
// seguir editándolo desde cualquier equipo) y el informe final en HTML —
// ambos se REEMPLAZAN cada vez (no se acumulan copias), mismo patrón que
// uploadChecklistType en controlSync.js.
import { DEFAULT_ROOT_FOLDER, findOrCreateDriveFolder, findFileByName, updateFileContent, uploadFile } from './googleDrive.js';

const ROOT_SUBFOLDER = 'ESTUDIO DE MERCADO';

function folderNameFor(estudio) {
  return [estudio.ao, estudio.nombreProyecto].filter(Boolean).join(' — ') || 'Sin nombre';
}

async function uploadOrReplace(folderId, filename, blob) {
  const existing = await findFileByName(folderId, filename);
  if (existing) {
    await updateFileContent(existing.id, blob);
  } else {
    await uploadFile(folderId, blob, filename);
  }
}

/** Sube (best-effort) el estudio completo + el informe HTML generado.
 * Devuelve true/false, nunca lanza error — el guardado local ya se hizo,
 * esto es solo el respaldo compartido. */
export async function uploadTasacionBackup(estudio, html) {
  try {
    const root = await findOrCreateDriveFolder(DEFAULT_ROOT_FOLDER.id, ROOT_SUBFOLDER);
    const folder = await findOrCreateDriveFolder(root.id, folderNameFor(estudio));
    const jsonBlob = new Blob([JSON.stringify(estudio)], { type: 'application/json' });
    await uploadOrReplace(folder.id, 'datos.json', jsonBlob);
    if (html) {
      const htmlBlob = new Blob([html], { type: 'text/html' });
      await uploadOrReplace(folder.id, `Estudio de mercado - ${estudio.nombreProyecto || estudio.ao}.html`, htmlBlob);
    }
    return { ok: true, folderId: folder.id };
  } catch (err) {
    console.error('No se pudo subir el respaldo del estudio de mercado a Drive:', err);
    return { ok: false };
  }
}
