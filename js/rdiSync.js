// Sincronización de RDI entre dispositivos — una carpeta de Drive por obra,
// un archivo por RDI (mismo patrón "gana el updatedAt más nuevo" que
// costosSync.js / controlSync.js).
import { listDriveJSONFiles, downloadDriveFile, uploadJSON } from './googleDrive.js';
import { getRdiSolicitudesByObra, upsertRdiSolicitud } from './db.js';

async function readJSONFile(fileId) {
  const blob = await downloadDriveFile(fileId);
  return JSON.parse(await blob.text());
}

export async function uploadRdiSolicitud(folderId, rdi) {
  if (!folderId) return false;
  try {
    await uploadJSON(folderId, `rdi-${rdi.id}.json`, rdi);
    return true;
  } catch (err) {
    console.error('No se pudo subir el RDI a Drive:', err);
    return false;
  }
}

export async function syncRdiFromDrive(obraId, folderId) {
  if (!folderId) return 0;
  const files = await listDriveJSONFiles(folderId);
  const relevant = files.filter((f) => f.name.startsWith('rdi-'));
  const local = await getRdiSolicitudesByObra(obraId);
  const localById = new Map(local.map((r) => [r.id, r]));

  let changed = 0;
  for (const file of relevant) {
    let data;
    try {
      data = await readJSONFile(file.id);
    } catch (err) {
      console.error(`No se pudo leer ${file.name} de Drive:`, err);
      continue;
    }
    const existing = localById.get(data.id);
    if (!existing || (existing.updatedAt || 0) < (data.updatedAt || 0)) {
      await upsertRdiSolicitud({ ...data, obraId });
      changed++;
    }
  }
  return changed;
}
