// Sincronización de Personal (SSMA) y Checklist diario entre los teléfonos
// de todo el equipo, vía una carpeta de Drive compartida por obra — mismo
// mecanismo que ya usa Avance programado, pero en las dos direcciones:
// cada guardado sube un .json a Drive, y cada apertura trae los que falten.
//
// Un archivo nuevo por guardado (no se actualiza uno existente) — más
// simple que rastrear un id de archivo a reemplazar. Si hay más de un
// archivo para el mismo día (dos personas guardaron el mismo día), se usa
// el que tenga el "updatedAt" más nuevo adentro, no el que se subió último
// a Drive — evita pisar un cambio más nuevo con uno viejo que tardó en
// subir por mala señal.
import { listDriveJSONFiles, listDriveScheduleFiles, listDriveFiles, listDriveFolders, findOrCreateDriveFolder, findFileByName, updateFileContent, downloadDriveFile, uploadFile, uploadJSON } from './googleDrive.js';
import { DEFAULT_CHECKLIST_TYPES } from './controlChecklistTemplates.js';
import {
  getSSMAEntryByObraAndDate,
  addSSMAEntry,
  updateSSMAEntry,
  ssmaEntryBreakdown,
  getChecklistTypesByObra,
  createChecklistType,
  updateChecklistType,
  getChecklistEntryByTypeAndDate,
  addChecklistEntry,
  updateChecklistEntry,
  getChecklistPhotosByEntry,
  addChecklistPhoto,
  addScheduleSnapshot,
  getScheduleSnapshotsByObra,
} from './db.js';
import { parseScheduleCSV, parseScheduleXLSX } from './controlScheduleParser.js';

// Project exporta el CSV en "Windows (ANSI)" por defecto, no UTF-8 — se
// intenta UTF-8 primero y si aparece el caracter de reemplazo (texto
// corrupto), se reintenta como Windows-1252 (ANSI).
function decodeCsvSmart(buf) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (utf8.includes('�')) return new TextDecoder('windows-1252').decode(buf);
  return utf8;
}

/** Trae de Drive las programaciones (.csv, .xlsx/.xls, o .mpp si `parseMPP`
 * se pasa) que todavía no se hayan importado — una por revisión, usa la
 * fecha real de modificación del archivo. `scheduleType` ('real' |
 * 'proyectada') marca con qué tipo quedan guardados TODOS los archivos de
 * esta carpeta — se llama una vez por carpeta/tipo (ver
 * controlAvanceView.js). Devuelve cuántas se importaron. */
export async function syncAvanceFromDrive(obraId, folderId, scheduleType = 'real', parseMPP = null) {
  if (!folderId) return 0;
  const snapshots = await getScheduleSnapshotsByObra(obraId);
  const files = await listDriveScheduleFiles(folderId);
  const pending = files.filter((f) => !snapshots.some((s) => s.driveFileId === f.id));
  let count = 0;
  for (const file of pending) {
    try {
      const blob = await downloadDriveFile(file.id);
      let parsed;
      if (/\.mpp$/i.test(file.name) && parseMPP) {
        parsed = await parseMPP(blob);
      } else if (/\.(xlsx|xls)$/i.test(file.name)) {
        parsed = parseScheduleXLSX(await blob.arrayBuffer());
      } else {
        parsed = parseScheduleCSV(decodeCsvSmart(await blob.arrayBuffer()));
      }
      await addScheduleSnapshot({
        obraId,
        tasks: parsed.tasks,
        overallPercent: parsed.overallPercent,
        scheduleType,
        driveFileId: file.id,
        driveFileName: file.name,
        uploadedAt: new Date(file.modifiedTime).getTime(),
      });
      count++;
    } catch (err) {
      console.error(`No se pudo importar ${file.name} de Drive:`, err);
    }
  }
  return count;
}

async function readJSONFile(fileId) {
  const blob = await downloadDriveFile(fileId);
  return JSON.parse(await blob.text());
}

/** Sube (best-effort) el registro de Personal de un día a Drive. No lanza
 * error si falla — el guardado local ya se hizo, esto es solo el respaldo
 * compartido. Devuelve true/false para que la pantalla pueda avisar si no
 * se pudo subir (antes fallaba calladito y no había forma de notar que
 * Drive no se estaba actualizando). */
export async function uploadSSMAEntry(folderId, entry) {
  if (!folderId) return false;
  try {
    const b = ssmaEntryBreakdown(entry);
    await uploadJSON(folderId, `${entry.date}.json`, {
      date: entry.date,
      personalDirecto: b.directo,
      personalIndirecto: b.indirecto,
      personalSubcontrato: b.subcontrato,
      nota: entry.nota,
      updatedAt: entry.updatedAt,
    });
    return true;
  } catch (err) {
    console.error('No se pudo subir el registro de personal a Drive:', err);
    return false;
  }
}

/** Trae de Drive los registros de Personal más nuevos que los locales.
 * Devuelve cuántos se crearon o actualizaron. */
export async function syncSSMAFromDrive(obraId, folderId) {
  if (!folderId) return 0;
  const files = await listDriveJSONFiles(folderId);
  const latestByDate = new Map();
  for (const f of files) {
    const date = f.name.replace(/\.json$/i, '');
    const prev = latestByDate.get(date);
    if (!prev || new Date(f.modifiedTime) > new Date(prev.modifiedTime)) latestByDate.set(date, f);
  }

  let changed = 0;
  for (const [date, file] of latestByDate) {
    let data;
    try {
      data = await readJSONFile(file.id);
    } catch (err) {
      console.error(`No se pudo leer ${file.name} de Drive:`, err);
      continue;
    }
    // ssmaEntryBreakdown tolera archivos viejos en Drive (de antes de
    // separar directo/indirecto) que todavía traigan solo "personalPropio".
    const b = ssmaEntryBreakdown(data);
    const local = await getSSMAEntryByObraAndDate(obraId, date);
    if (!local) {
      await addSSMAEntry({ obraId, date: data.date, personalDirecto: b.directo, personalIndirecto: b.indirecto, personalSubcontrato: b.subcontrato, nota: data.nota, updatedAt: data.updatedAt });
      changed++;
    } else if ((local.updatedAt || 0) < (data.updatedAt || 0)) {
      await updateSSMAEntry(local.id, { personalDirecto: b.directo, personalIndirecto: b.indirecto, personalSubcontrato: b.subcontrato, nota: data.nota }, { updatedAt: data.updatedAt });
      changed++;
    }
  }
  return changed;
}

/**
 * Sube (best-effort) la LISTA DE PREGUNTAS de un tipo de checklist (los
 * textos de "✏️ Editar ítems de esta lista") — a diferencia de
 * uploadChecklistEntry (que sube un archivo nuevo por día), acá hay un solo
 * estado vigente por tipo, así que se sobreescribe el mismo archivo
 * (`checklist-type-<key>.json`), mismo patrón que `permissions.json`. Antes
 * de esto, editar el texto de una pregunta nunca salía del teléfono que lo
 * editó — Pancho lo pidió después de que un cambio "se perdiera" al mirarlo
 * desde otro aparato.
 */
export async function uploadChecklistType(folderId, type) {
  if (!folderId) return false;
  try {
    const filename = `checklist-type-${type.key}.json`;
    const blob = new Blob([JSON.stringify({ key: type.key, title: type.title, items: type.items, updatedAt: type.updatedAt })], { type: 'application/json' });
    const existing = await findFileByName(folderId, filename);
    if (existing) {
      await updateFileContent(existing.id, blob);
    } else {
      await uploadFile(folderId, blob, filename);
    }
    return true;
  } catch (err) {
    console.error('No se pudo subir la lista de ítems del checklist a Drive:', err);
    return false;
  }
}

/** Trae de Drive la lista de preguntas más reciente de cada tipo de
 * checklist (SSMA/Faenas/Programación), si es más nueva que la local. */
export async function syncChecklistTypesFromDrive(obraId, folderId) {
  if (!folderId) return 0;
  let types = await getChecklistTypesByObra(obraId);
  if (!types.length) {
    types = await Promise.all(DEFAULT_CHECKLIST_TYPES.map((t, i) => createChecklistType({ obraId, order: i, ...t })));
  }

  let changed = 0;
  await Promise.all(
    types.map(async (type) => {
      try {
        const file = await findFileByName(folderId, `checklist-type-${type.key}.json`);
        if (!file) return;
        const data = await readJSONFile(file.id);
        if ((data.updatedAt || 0) > (type.updatedAt || 0)) {
          await updateChecklistType(type.id, { title: data.title, items: data.items }, { updatedAt: data.updatedAt });
          changed++;
        }
      } catch (err) {
        console.error(`No se pudo leer la lista de ítems de "${type.key}" desde Drive:`, err);
      }
    })
  );
  return changed;
}

/** Sube (best-effort) un checklist de un día a Drive.
 *
 * OJO: se guarda `typeKey` ('ssma'/'faenas'/'programacion'), NO
 * `entry.checklistTypeId` — ese id es local a cada teléfono (se arma con
 * el id de la obra, que cada dispositivo genera por su cuenta al crear su
 * propia obra local, así que nunca va a coincidir entre el teléfono de
 * Pancho y el de Sergio aunque estén mirando la misma obra real). `typeKey`
 * en cambio es el mismo siempre, así que sirve para reconocer el tipo de
 * checklist correcto en CUALQUIER dispositivo que sincronice esta carpeta.
 */
export async function uploadChecklistEntry(folderId, typeKey, entry) {
  if (!folderId) return false;
  try {
    await uploadJSON(folderId, `${typeKey}-${entry.date}.json`, {
      typeKey,
      date: entry.date,
      items: entry.items,
      updatedAt: entry.updatedAt,
    });
    return true;
  } catch (err) {
    console.error('No se pudo subir el checklist a Drive:', err);
    return false;
  }
}

/** Trae de Drive los checklists más nuevos que los locales, para todos los
 * tipos (SSMA/Faenas/Programación) de una obra. Devuelve cuántos cambiaron. */
export async function syncChecklistFromDrive(obraId, folderId) {
  if (!folderId) return 0;
  // Si este dispositivo nunca abrió la pantalla de Checklist para esta
  // obra, todavía no tiene los 3 tipos (SSMA/Faenas/Programación) creados
  // localmente — sin esto, la sync no tendría dónde guardar lo que traiga
  // de Drive. Se crean acá mismo, igual que hace controlChecklistView.js.
  let types = await getChecklistTypesByObra(obraId);
  if (!types.length) {
    types = await Promise.all(DEFAULT_CHECKLIST_TYPES.map((t, i) => createChecklistType({ obraId, order: i, ...t })));
  }

  const files = await listDriveJSONFiles(folderId);
  const latestByName = new Map();
  for (const f of files) {
    const name = f.name.replace(/\.json$/i, '');
    const prev = latestByName.get(name);
    if (!prev || new Date(f.modifiedTime) > new Date(prev.modifiedTime)) latestByName.set(name, f);
  }

  // Los archivos se leen todos EN PARALELO (antes uno por uno, en fila —
  // con meses de uso real esto son decenas de archivos, y esperarlos de a
  // uno es la razón principal de que la sincronización se sintiera lenta).
  // Los guardados en la base local sí quedan uno por uno después (son
  // locales, instantáneos, no hace falta paralelizarlos).
  const downloaded = await Promise.all(
    [...latestByName.values()].map(async (file) => {
      try {
        return await readJSONFile(file.id);
      } catch (err) {
        console.error(`No se pudo leer ${file.name} de Drive:`, err);
        return null;
      }
    })
  );

  let changed = 0;
  for (const data of downloaded) {
    if (!data) continue;
    // Se resuelve por `key` (portable), no por id — ver nota en uploadChecklistEntry.
    const type = types.find((t) => t.key === data.typeKey);
    if (!type) continue; // tipo desconocido (raro: los 3 tipos por defecto siempre existen)
    const local = await getChecklistEntryByTypeAndDate(type.id, data.date);
    if (!local) {
      await addChecklistEntry({ obraId, checklistTypeId: type.id, date: data.date, items: data.items, updatedAt: data.updatedAt });
      changed++;
    } else if ((local.updatedAt || 0) < (data.updatedAt || 0)) {
      await updateChecklistEntry(local.id, { items: data.items }, { updatedAt: data.updatedAt });
      changed++;
    }
  }
  return changed;
}

/**
 * Sube (best-effort) una foto del checklist a Drive, ORDENADA en
 * subcarpetas Tipo → Fecha (ej. "SSMA/2026-09-01/") dentro de la carpeta de
 * Checklist vinculada — así queda prolijo para mirar directo en Drive, sin
 * que Pancho tenga que ordenar nada a mano. `typeTitle` es el nombre lindo
 * del tipo (ej. "SSMA"), no la `key` interna.
 */
export async function uploadChecklistPhoto(folderId, typeTitle, date, photo) {
  if (!folderId) return false;
  try {
    const typeFolder = await findOrCreateDriveFolder(folderId, typeTitle);
    const dateFolder = await findOrCreateDriveFolder(typeFolder.id, date);
    await uploadFile(dateFolder.id, photo.blob, `foto_${photo.id}.jpg`);
    return true;
  } catch (err) {
    console.error('No se pudo subir la foto del checklist a Drive:', err);
    return false;
  }
}

// Cuántos días hacia atrás se revisan las carpetas de fecha en busca de
// fotos nuevas — más allá de esto se asume que un día ya cerrado no va a
// recibir fotos nuevas. Sin este límite, cada mes que pasa la sincronización
// tiene que recorrer una carpeta de fecha más (y cada una es una llamada a
// Drive), así que con meses de uso real esto se iba poniendo cada vez más
// lento — era la causa principal de la lentitud que notó Pancho.
const PHOTO_SYNC_LOOKBACK_DAYS = 30;

/**
 * Trae de Drive las fotos de checklist que todavía no están en este
 * teléfono, recorriendo la misma estructura Tipo → Fecha que arma
 * `uploadChecklistPhoto` — el tipo se resuelve por el NOMBRE de la
 * subcarpeta (case-insensitive, contra `type.title`) y la fecha por el
 * nombre de la subcarpeta siguiente (debe verse como "2026-09-01"). Se
 * identifican por el id de Drive del archivo (guardado como `driveFileId`
 * en cada foto local) — nunca se vuelve a bajar la misma.
 *
 * Todo lo que es solo "listar qué hay" (carpetas de tipo, carpetas de
 * fecha, archivos dentro de cada una) se hace EN PARALELO — antes era todo
 * secuencial (una llamada a Drive esperando a la anterior, carpeta por
 * carpeta, día por día), que con varias semanas de checklist ya sumaba
 * decenas de segundos. Las fotos realmente nuevas se siguen bajando de a
 * una (son archivos pesados, no vale la pena saturar la conexión del
 * teléfono bajando varias a la vez).
 */
export async function syncChecklistPhotosFromDrive(obraId, folderId) {
  if (!folderId) return 0;
  let types = await getChecklistTypesByObra(obraId);
  if (!types.length) {
    types = await Promise.all(DEFAULT_CHECKLIST_TYPES.map((t, i) => createChecklistType({ obraId, order: i, ...t })));
  }

  const cutoff = new Date(Date.now() - PHOTO_SYNC_LOOKBACK_DAYS * 86400000);
  const cutoffISO = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;

  const typeFolders = await listDriveFolders(folderId);

  // Cachea las fotos ya bajadas por checklist local, para no volver a
  // consultar la base de datos por cada archivo.
  const knownDriveIdsByChecklist = new Map();
  async function alreadyHas(checklistId, fileId) {
    if (!knownDriveIdsByChecklist.has(checklistId)) {
      const local = await getChecklistPhotosByEntry(checklistId);
      knownDriveIdsByChecklist.set(checklistId, new Set(local.map((p) => p.driveFileId).filter(Boolean)));
    }
    return knownDriveIdsByChecklist.get(checklistId).has(fileId);
  }

  // Junta, en paralelo, la lista de archivos-imagen a revisar de TODAS las
  // carpetas de fecha recientes de TODOS los tipos — recién con esa lista
  // completa se empieza a bajar. `pending`: [{ entry, file }].
  const perType = await Promise.all(
    typeFolders.map(async (typeFolder) => {
      const type = types.find((t) => t.title.trim().toLowerCase() === typeFolder.name.trim().toLowerCase());
      if (!type) return []; // subcarpeta que no corresponde a ningún tipo conocido

      const dateFolders = (await listDriveFolders(typeFolder.id)).filter(
        (f) => /^\d{4}-\d{2}-\d{2}$/.test(f.name) && f.name >= cutoffISO // comparación de string ISO = comparación de fecha
      );

      const perDate = await Promise.all(
        dateFolders.map(async (dateFolder) => {
          const entry = await getChecklistEntryByTypeAndDate(type.id, dateFolder.name);
          if (!entry) return []; // todavía no llegó el checklist de ese día — se resuelve en un próximo sync
          const files = await listDriveFiles(dateFolder.id); // ya filtra por mimeType imagen
          return files.map((file) => ({ entry, file }));
        })
      );
      return perDate.flat();
    })
  );
  const pending = perType.flat();

  let added = 0;
  for (const { entry, file } of pending) {
    if (await alreadyHas(entry.id, file.id)) continue;
    try {
      const blob = await downloadDriveFile(file.id);
      await addChecklistPhoto({
        id: `photo-drive-${file.id}`, // determinístico — evita duplicar si se dispara 2 veces
        checklistId: entry.id,
        blob,
        driveFileId: file.id,
      });
      knownDriveIdsByChecklist.get(entry.id).add(file.id);
      added++;
    } catch (err) {
      if (err?.name === 'ConstraintError') continue; // ya la había bajado otra corrida en paralelo
      console.error(`No se pudo bajar la foto "${file.name}" de Drive:`, err);
    }
  }
  return added;
}
