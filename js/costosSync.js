// Sincronización del módulo Costos entre dispositivos, vía UNA sola carpeta
// de Drive por obra (a diferencia de Control, que linkea una carpeta por
// sección) — en la práctica Costos lo actualiza una sola persona (Pancho o
// quien lleve la plata de la obra), así que no hace falta separar.
//
// El contrato es un único archivo que se sobrescribe (mismo patrón que
// `permissions.js`: findFileByName + updateFileContent si existe, si no
// uploadFile). Modificaciones/Facturas/Reembolsos son un archivo nuevo por
// registro (mismo patrón que Personal/Checklist en `controlSync.js`):
// "gana" el que tenga `updatedAt` más nuevo adentro, no el que llegó último
// a Drive.
import { listDriveJSONFiles, downloadDriveFile, uploadJSON, findFileByName, updateFileContent, uploadFile } from './googleDrive.js';
import {
  getCostosContrato,
  saveCostosContrato,
  getCostosModificacionesByObra,
  upsertCostosModificacion,
  getCostosFacturasByObra,
  upsertCostosFactura,
  getCostosReembolsosByObra,
  upsertCostosReembolso,
} from './db.js';

const CONTRATO_FILE = 'contrato.json';

async function readJSONFile(fileId) {
  const blob = await downloadDriveFile(fileId);
  return JSON.parse(await blob.text());
}

// ---------- Contrato (1 solo archivo, se sobrescribe) ----------

export async function uploadContrato(folderId, contrato) {
  if (!folderId) return false;
  try {
    const blob = new Blob([JSON.stringify(contrato)], { type: 'application/json' });
    const existing = await findFileByName(folderId, CONTRATO_FILE);
    if (existing) {
      await updateFileContent(existing.id, blob);
    } else {
      await uploadFile(folderId, blob, CONTRATO_FILE);
    }
    return true;
  } catch (err) {
    console.error('No se pudo subir el contrato a Drive:', err);
    return false;
  }
}

export async function syncContratoFromDrive(obraId, folderId) {
  if (!folderId) return false;
  try {
    const file = await findFileByName(folderId, CONTRATO_FILE);
    if (!file) return false;
    const data = await readJSONFile(file.id);
    const local = await getCostosContrato(obraId);
    if (!local || (local.updatedAt || 0) < (data.updatedAt || 0)) {
      await saveCostosContrato({ ...data, obraId });
      return true;
    }
    return false;
  } catch (err) {
    console.error('No se pudo traer el contrato desde Drive:', err);
    return false;
  }
}

// ---------- Modificaciones ----------

export async function uploadModificacion(folderId, mo) {
  if (!folderId) return false;
  try {
    await uploadJSON(folderId, `mod-${mo.id}.json`, mo);
    return true;
  } catch (err) {
    console.error('No se pudo subir la modificación a Drive:', err);
    return false;
  }
}

export async function syncModificacionesFromDrive(obraId, folderId) {
  if (!folderId) return 0;
  return syncRecordsFromDrive(folderId, 'mod-', obraId, getCostosModificacionesByObra, upsertCostosModificacion);
}

// ---------- Facturación ----------

export async function uploadFactura(folderId, factura) {
  if (!folderId) return false;
  try {
    await uploadJSON(folderId, `factura-${factura.id}.json`, factura);
    return true;
  } catch (err) {
    console.error('No se pudo subir la factura a Drive:', err);
    return false;
  }
}

export async function syncFacturasFromDrive(obraId, folderId) {
  if (!folderId) return 0;
  return syncRecordsFromDrive(folderId, 'factura-', obraId, getCostosFacturasByObra, upsertCostosFactura);
}

// ---------- Reembolsos ----------

export async function uploadReembolso(folderId, reembolso) {
  if (!folderId) return false;
  try {
    await uploadJSON(folderId, `reembolso-${reembolso.id}.json`, reembolso);
    return true;
  } catch (err) {
    console.error('No se pudo subir el reembolso a Drive:', err);
    return false;
  }
}

export async function syncReembolsosFromDrive(obraId, folderId) {
  if (!folderId) return 0;
  return syncRecordsFromDrive(folderId, 'reembolso-', obraId, getCostosReembolsosByObra, upsertCostosReembolso);
}

/** Lógica común a los 3 tipos de lista: trae de Drive los archivos con el
 * prefijo dado, y crea/reemplaza el registro local por `id` (portable entre
 * dispositivos porque viaja completo dentro del JSON — a diferencia del
 * `checklistTypeId` de Control, acá no hay que resolver nada local, el
 * `id` del registro es el mismo en todos los teléfonos) si no existe
 * todavía o si el que trae Drive es más nuevo. */
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
