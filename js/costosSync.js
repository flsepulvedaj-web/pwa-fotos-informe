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
import { listDriveJSONFiles, listDriveScheduleFiles, downloadDriveFile, uploadJSON, findFileByName, updateFileContent, uploadFile } from './googleDrive.js';
import { parsePresupuestoDetalleXLSX } from './costosPresupuestoParser.js';
import { parseEstadoPagoXLSX } from './costosEstadoPagoParser.js';
import {
  getCostosContrato,
  saveCostosContrato,
  getCostosPresupuestoDetalle,
  saveCostosPresupuestoDetalle,
  getCostosModificacionesByObra,
  upsertCostosModificacion,
  getCostosFacturasByObra,
  addCostosFactura,
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

// ---------- Presupuesto original detallado (1 Excel, se reemplaza) ----------

/** A diferencia del contrato (que la app misma edita y sube), el desglose
 * de partidas siempre viene de un Excel que el contratista arma — acá solo
 * se lee desde Drive, nunca se sube de vuelta. Se usa el archivo .xlsx más
 * reciente de la carpeta (mismo criterio que Avance con la programación). */
export async function syncPresupuestoDetalleFromDrive(obraId, folderId) {
  if (!folderId) return false;
  const files = (await listDriveScheduleFiles(folderId)).filter((f) => /\.xlsx?$/i.test(f.name));
  if (!files.length) return false;
  const newest = files[0]; // listDriveScheduleFiles ya ordena por modifiedTime desc
  const local = await getCostosPresupuestoDetalle(obraId);
  if (local && local.sourceFileId === newest.id && local.sourceModifiedTime === newest.modifiedTime) {
    return false; // mismo archivo, sin cambios
  }
  const blob = await downloadDriveFile(newest.id);
  const buffer = await blob.arrayBuffer();
  const { items, grandTotal } = parsePresupuestoDetalleXLSX(buffer);
  await saveCostosPresupuestoDetalle({
    obraId,
    items,
    grandTotal,
    sourceFileName: newest.name,
    sourceFileId: newest.id,
    sourceModifiedTime: newest.modifiedTime,
  });
  return true;
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

/**
 * Carpeta aparte ("ESTADOS DE PAGO" en Drive) donde el contratista va
 * dejando un Excel por cada EP — a diferencia de syncFacturasFromDrive (que
 * sincroniza los REGISTROS ya cargados en la app, como JSON, entre
 * teléfonos), esto lee Excels crudos y crea un estado de pago nuevo por
 * cada archivo que todavía no se haya importado (identificado por el id de
 * Drive del archivo, guardado en `sourceFileId` — así no se duplica si se
 * vuelve a sincronizar). Cada uno que se crea se sube igual como JSON al
 * mismo `costosDriveFolderId` de siempre (recibido acá como
 * `propagateFolderId`), para que le llegue al resto del equipo por el
 * camino ya conocido.
 */
export async function syncEstadosPagoFromDrive(obraId, folderId, propagateFolderId) {
  if (!folderId) return 0;
  const files = (await listDriveScheduleFiles(folderId)).filter((f) => /\.xlsx?$/i.test(f.name));
  if (!files.length) return 0;
  const existing = await getCostosFacturasByObra(obraId);
  const already = new Set(existing.map((f) => f.sourceFileId).filter(Boolean));

  let added = 0;
  for (const file of files) {
    if (already.has(file.id)) continue;
    try {
      const blob = await downloadDriveFile(file.id);
      const buffer = await blob.arrayBuffer();
      const parsed = parseEstadoPagoXLSX(buffer);
      const saved = await addCostosFactura({
        obraId,
        tipo: 'contractual',
        item: parsed.epNumber !== '' ? `EP N°${parsed.epNumber}` : file.name,
        numeroFactura: parsed.epNumber !== '' ? String(parsed.epNumber) : '',
        fecha: parsed.fecha || new Date().toISOString().slice(0, 10),
        avanceNetoPeriodo: parsed.avanceNetoPeriodo,
        anticipoPeriodo: parsed.anticipoPeriodo,
        retencionPeriodo: parsed.retencionPeriodo,
        items: parsed.items,
        sourceFileId: file.id,
        sourceFileName: file.name,
      });
      if (propagateFolderId) await uploadFactura(propagateFolderId, saved);
      added++;
    } catch (err) {
      console.error(`No se pudo leer el estado de pago "${file.name}" de Drive:`, err);
    }
  }
  return added;
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
