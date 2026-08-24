// Sincronización de los módulos "chicos" (Subcontratos y Organismos
// Públicos) — comparten UNA sola carpeta de Drive por obra (igual que
// Costos: son chicos, no vale la pena pedirle a Pancho que vincule 2
// carpetas separadas). Un archivo por registro, "gana" el updatedAt más
// nuevo — mismo mecanismo que costosSync.js / rdiSync.js.
import { listDriveJSONFiles, downloadDriveFile, uploadJSON } from './googleDrive.js';
import {
  getSubcontratosByObra,
  upsertSubcontrato,
  getOrganismosTramitesByObra,
  upsertOrganismoTramite,
} from './db.js';

async function readJSONFile(fileId) {
  const blob = await downloadDriveFile(fileId);
  return JSON.parse(await blob.text());
}

async function syncRecordsFromDrive(folderId, prefix, obraId, getLocal, upsertLocal) {
  const files = await listDriveJSONFiles(folderId);
  const relevant = files.filter((f) => f.name.startsWith(prefix));
  const local = await getLocal(obraId);
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
      await upsertLocal({ ...data, obraId });
      changed++;
    }
  }
  return changed;
}

export async function uploadSubcontrato(folderId, sub) {
  if (!folderId) return false;
  try {
    await uploadJSON(folderId, `subcontrato-${sub.id}.json`, sub);
    return true;
  } catch (err) {
    console.error('No se pudo subir el subcontrato a Drive:', err);
    return false;
  }
}

export async function syncSubcontratosFromDrive(obraId, folderId) {
  if (!folderId) return 0;
  return syncRecordsFromDrive(folderId, 'subcontrato-', obraId, getSubcontratosByObra, upsertSubcontrato);
}

export async function uploadOrganismoTramite(folderId, tramite) {
  if (!folderId) return false;
  try {
    await uploadJSON(folderId, `organismo-${tramite.id}.json`, tramite);
    return true;
  } catch (err) {
    console.error('No se pudo subir el trámite a Drive:', err);
    return false;
  }
}

export async function syncOrganismosFromDrive(obraId, folderId) {
  if (!folderId) return 0;
  return syncRecordsFromDrive(folderId, 'organismo-', obraId, getOrganismosTramitesByObra, upsertOrganismoTramite);
}
