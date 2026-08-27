// "Reiniciar pendientes" de una obra: borra el historial de Checklist
// diario (con sus fotos) y de Avance programado — exactamente lo que
// alimenta el panel "Pendientes" del dashboard de Control (incumplimientos
// de checklist + tareas de programación atrasadas). Personal en obra,
// Protocolos y los módulos nuevos (Costos/RDI/Subcontratos/Organismos/
// Informe Semanal) NO se tocan — no son parte de "Pendientes".
//
// Borra tanto local (IndexedDB) como en Drive (a la papelera, no para
// siempre — ver `trashDriveFile`), para que la próxima sincronización no
// traiga de vuelta lo que se acaba de borrar.
import {
  getChecklistEntriesByObra,
  deleteChecklistEntry,
  getScheduleSnapshotsByObra,
  deleteScheduleSnapshot,
} from './db.js';
import { listDriveJSONFiles, listDriveScheduleFiles, trashDriveFile } from './googleDrive.js';

/** Manda a la papelera de Drive todos los archivos de una carpeta, uno por
 * uno (best-effort: si uno falla, sigue con el resto). Devuelve cuántos se
 * lograron borrar y cuántos fallaron. */
async function trashAllInFolder(folderId, listFn) {
  if (!folderId) return { ok: 0, failed: 0 };
  let files;
  try {
    files = await listFn(folderId);
  } catch (err) {
    console.error('No se pudo listar la carpeta de Drive para reiniciar:', err);
    return { ok: 0, failed: 0 };
  }
  let ok = 0;
  let failed = 0;
  for (const f of files) {
    try {
      await trashDriveFile(f.id);
      ok++;
    } catch (err) {
      console.error(`No se pudo mover a la papelera ${f.name}:`, err);
      failed++;
    }
  }
  return { ok, failed };
}

export async function resetPendientes(obraId, obra) {
  const [entries, snapshots] = await Promise.all([
    getChecklistEntriesByObra(obraId),
    getScheduleSnapshotsByObra(obraId),
  ]);

  for (const e of entries) {
    await deleteChecklistEntry(e.id); // ya borra sus fotos de paso
  }
  for (const s of snapshots) {
    await deleteScheduleSnapshot(s.id);
  }

  const [checklistDrive, avanceDrive] = await Promise.all([
    trashAllInFolder(obra.checklistDriveFolderId, listDriveJSONFiles),
    trashAllInFolder(obra.programacionDriveFolderId, listDriveScheduleFiles),
  ]);

  return {
    checklistBorrados: entries.length,
    snapshotsBorrados: snapshots.length,
    driveOk: checklistDrive.ok + avanceDrive.ok,
    driveFailed: checklistDrive.failed + avanceDrive.failed,
  };
}
