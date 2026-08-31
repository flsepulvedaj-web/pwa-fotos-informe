import { uuid } from './utils.js';

const DB_NAME = 'fotos-informe-db';
const DB_VERSION = 10;

// IndexedDB no permite `null`/`undefined` como clave de índice: los registros
// con ese valor simplemente no se indexan. Usamos '' como id de la carpeta
// raíz para que las consultas por índice (by_parentId, by_folderId) funcionen.
export const ROOT_ID = '';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;

      if (!db.objectStoreNames.contains('folders')) {
        const folders = db.createObjectStore('folders', { keyPath: 'id' });
        folders.createIndex('by_parentId', 'parentId', { unique: false });
      }

      if (!db.objectStoreNames.contains('photos')) {
        const photos = db.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('by_folderId', 'folderId', { unique: false });
      }

      // Módulo Protocolos (v2): árbol completamente aparte del de fotos —
      // no son carpetas anidadas, son obras con protocolos adentro.
      if (!db.objectStoreNames.contains('obras')) {
        db.createObjectStore('obras', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('protocolInstances')) {
        const instances = db.createObjectStore('protocolInstances', { keyPath: 'id' });
        instances.createIndex('by_obraId', 'obraId', { unique: false });
      }

      if (!db.objectStoreNames.contains('protocolPhotos')) {
        const protocolPhotos = db.createObjectStore('protocolPhotos', { keyPath: 'id' });
        protocolPhotos.createIndex('by_instanceId', 'instanceId', { unique: false });
      }

      // Módulo Control (v3): programación, checklist diario, SSMA y actas —
      // todos cuelgan de la misma obra que ya usa Protocolos (by_obraId).
      if (!db.objectStoreNames.contains('controlSchedule')) {
        const controlSchedule = db.createObjectStore('controlSchedule', { keyPath: 'id' });
        controlSchedule.createIndex('by_obraId', 'obraId', { unique: false });
      }

      if (!db.objectStoreNames.contains('controlChecklistTypes')) {
        const controlChecklistTypes = db.createObjectStore('controlChecklistTypes', { keyPath: 'id' });
        controlChecklistTypes.createIndex('by_obraId', 'obraId', { unique: false });
      }

      // Store separada del `if` de arriba (a diferencia del resto de este
      // archivo) porque este índice se agregó en una versión posterior a la
      // que creó la store — sin este manejo aparte, una base que ya tenía
      // 'controlChecklists' (sin el índice nuevo) se saltaría el bloque
      // entero y se quedaría sin 'by_typeId' para siempre.
      let controlChecklists;
      if (!db.objectStoreNames.contains('controlChecklists')) {
        controlChecklists = db.createObjectStore('controlChecklists', { keyPath: 'id' });
        controlChecklists.createIndex('by_obraId', 'obraId', { unique: false });
      } else {
        controlChecklists = req.transaction.objectStore('controlChecklists');
      }
      if (!controlChecklists.indexNames.contains('by_typeId')) {
        controlChecklists.createIndex('by_typeId', 'checklistTypeId', { unique: false });
      }

      if (!db.objectStoreNames.contains('controlChecklistPhotos')) {
        const controlChecklistPhotos = db.createObjectStore('controlChecklistPhotos', { keyPath: 'id' });
        controlChecklistPhotos.createIndex('by_checklistId', 'checklistId', { unique: false });
      }

      if (!db.objectStoreNames.contains('controlSSMA')) {
        const controlSSMA = db.createObjectStore('controlSSMA', { keyPath: 'id' });
        controlSSMA.createIndex('by_obraId', 'obraId', { unique: false });
      }

      if (!db.objectStoreNames.contains('controlActas')) {
        const controlActas = db.createObjectStore('controlActas', { keyPath: 'id' });
        controlActas.createIndex('by_obraId', 'obraId', { unique: false });
      }

      // Módulo Costos (v5): presupuesto, modificaciones, facturación y
      // reembolsos — módulo aparte de Control porque es información
      // sensible (plata del contrato), con permiso propio. También cuelga
      // de la misma obra que el resto (by_obraId).
      if (!db.objectStoreNames.contains('costosContrato')) {
        // keyPath 'obraId' (no 'id'): es 1 registro por obra, no una lista
        // — así basta un `put` para crear o actualizar (upsert natural).
        db.createObjectStore('costosContrato', { keyPath: 'obraId' });
      }

      if (!db.objectStoreNames.contains('costosModificaciones')) {
        const costosModificaciones = db.createObjectStore('costosModificaciones', { keyPath: 'id' });
        costosModificaciones.createIndex('by_obraId', 'obraId', { unique: false });
      }

      if (!db.objectStoreNames.contains('costosFacturas')) {
        const costosFacturas = db.createObjectStore('costosFacturas', { keyPath: 'id' });
        costosFacturas.createIndex('by_obraId', 'obraId', { unique: false });
      }

      if (!db.objectStoreNames.contains('costosReembolsos')) {
        const costosReembolsos = db.createObjectStore('costosReembolsos', { keyPath: 'id' });
        costosReembolsos.createIndex('by_obraId', 'obraId', { unique: false });
      }

      // Módulo RDI (v6): requerimientos de información al mandante — lo
      // clave es saber cuánto se demora en responder (le da días a la
      // constructora y sirve para presionar). Permiso propio, distinto de
      // Costos: no es plata, así que puede tener sentido dárselo también a
      // quien está en terreno.
      if (!db.objectStoreNames.contains('rdiSolicitudes')) {
        const rdiSolicitudes = db.createObjectStore('rdiSolicitudes', { keyPath: 'id' });
        rdiSolicitudes.createIndex('by_obraId', 'obraId', { unique: false });
      }

      // Módulos "chicos" (v7): Subcontratos y Organismos Públicos — listas
      // simples de directorio/seguimiento, sin dashboard propio. A
      // diferencia de Costos/RDI, no tienen permiso aparte: cualquiera con
      // acceso a Control las ve (no es información sensible, es una
      // agenda/checklist de trámites).
      if (!db.objectStoreNames.contains('subcontratos')) {
        const subcontratos = db.createObjectStore('subcontratos', { keyPath: 'id' });
        subcontratos.createIndex('by_obraId', 'obraId', { unique: false });
      }

      if (!db.objectStoreNames.contains('organismosPublicos')) {
        const organismosPublicos = db.createObjectStore('organismosPublicos', { keyPath: 'id' });
        organismosPublicos.createIndex('by_obraId', 'obraId', { unique: false });
      }

      // Informe Semanal (v8): acta de reunión (participantes, temas,
      // firmas) + compilado de KPI de los demás módulos, exportado a PDF.
      // Reemplaza el placeholder "Actas de reunión" de Control.
      if (!db.objectStoreNames.contains('informesSemanales')) {
        const informesSemanales = db.createObjectStore('informesSemanales', { keyPath: 'id' });
        informesSemanales.createIndex('by_obraId', 'obraId', { unique: false });
      }

      // Lista de ids de obra borradas (v9) — la sincronización de la lista
      // de obras (obraSync.js) es aditiva por naturaleza (cada teléfono solo
      // agrega/actualiza lo que baja de Drive, nunca borra algo que ya tenía
      // local). Sin esto, borrar una obra duplicada en un teléfono no le
      // llegaba nunca a los demás — cada uno se quedaba con su propia copia
      // para siempre. Esta lista ("tumba") se sube junto al índice de obras
      // y cada teléfono, al sincronizar, borra localmente cualquier obra
      // cuyo id aparezca acá.
      if (!db.objectStoreNames.contains('obraTombstones')) {
        db.createObjectStore('obraTombstones', { keyPath: 'id' });
      }

      // Presupuesto original detallado por partidas (v10): desglose completo
      // (categoría, ítem, descripción, unidad, cantidad, precio unitario,
      // total) extraído de la planilla del contratista — 1 registro por
      // obra (como costosContrato), se reemplaza entero cada vez que se
      // vuelve a subir un archivo. Separado de costosContrato porque es una
      // lista larga, no un puñado de números.
      if (!db.objectStoreNames.contains('costosPresupuestoDetalle')) {
        db.createObjectStore('costosPresupuestoDetalle', { keyPath: 'obraId' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------- Folders ----------

export async function createFolder(name, parentId = ROOT_ID, description = '') {
  const store = await tx('folders', 'readwrite');
  const folder = { id: uuid(), name, parentId, description, createdAt: Date.now() };
  await wrap(store.add(folder));
  return folder;
}

export async function getFolder(id) {
  const store = await tx('folders', 'readonly');
  return wrap(store.get(id));
}

export async function getChildFolders(parentId = ROOT_ID) {
  const store = await tx('folders', 'readonly');
  const index = store.index('by_parentId');
  const results = await wrap(index.getAll(parentId));
  // { numeric: true } ordena "Piso 2" antes que "Piso 10" (como número, no
  // como texto) — sin esto, "1" es menor que "2" letra por letra y las
  // carpetas numeradas (casas, deptos, pisos) salían todas desordenadas.
  return results.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
}

export async function updateFolder(id, changes) {
  const store = await tx('folders', 'readwrite');
  const folder = await wrap(store.get(id));
  if (!folder) return null;
  Object.assign(folder, changes);
  await wrap(store.put(folder));
  return folder;
}

export async function getAllFolders() {
  const result = [];
  async function walk(parentId, depth) {
    const children = await getChildFolders(parentId);
    for (const child of children) {
      result.push({ id: child.id, name: child.name, depth });
      await walk(child.id, depth + 1);
    }
  }
  await walk(ROOT_ID, 0);
  return result;
}

export async function getPinnedFolders() {
  const store = await tx('folders', 'readonly');
  const all = await wrap(store.getAll());
  return all.filter((f) => f.pinned).sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
}

export async function deleteFolderRecursive(id) {
  const children = await getChildFolders(id);
  for (const child of children) {
    await deleteFolderRecursive(child.id);
  }
  const photos = await getPhotosByFolder(id);
  for (const photo of photos) {
    await deletePhoto(photo.id);
  }
  const store = await tx('folders', 'readwrite');
  await wrap(store.delete(id));
}

export async function getFolderPath(id) {
  const path = [];
  let current = id;
  while (current) {
    const folder = await getFolder(current);
    if (!folder) break;
    path.unshift(folder);
    current = folder.parentId;
  }
  return path;
}

// ---------- Photos ----------

export async function addPhoto({ folderId, blob, title = '', note = '', syncStatus = null, driveFileId = null }) {
  const store = await tx('photos', 'readwrite');
  const photo = {
    id: uuid(),
    folderId,
    blob,
    title,
    note,
    createdAt: Date.now(),
    syncStatus,
    // Id del archivo en Drive cuando la foto llegó DESDE Drive (alguien la
    // subió directo ahí, sin pasar por la app) — sirve para no volver a
    // descargarla en cada sincronización ni tampoco volver a subirla.
    driveFileId,
  };
  await wrap(store.add(photo));
  return photo;
}

export async function getPendingUploads() {
  const store = await tx('photos', 'readonly');
  const all = await wrap(store.getAll());
  // 'error' se reintenta igual que 'pending' — antes una foto que fallaba
  // una vez (ej. porque la sesión de Google venció a mitad de la subida)
  // quedaba marcada como error para siempre, sin ningún reintento automático.
  return all
    .filter((p) => p.syncStatus === 'pending' || p.syncStatus === 'error')
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPhoto(id) {
  const store = await tx('photos', 'readonly');
  return wrap(store.get(id));
}

export async function getPhotosByFolder(folderId) {
  const store = await tx('photos', 'readonly');
  const index = store.index('by_folderId');
  const results = await wrap(index.getAll(folderId));
  return results.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Solo el número de fotos de una carpeta (sin traer las fotos completas —
 * más liviano para pintar el "tiene fotos" de varias carpetas a la vez en
 * la grilla, ej. las 50 casas de un loteo).
 */
export async function getPhotoCountByFolder(folderId) {
  const store = await tx('photos', 'readonly');
  const index = store.index('by_folderId');
  return wrap(index.count(folderId));
}

/**
 * Igual que getPhotoCountByFolder, pero sumando también las fotos de
 * todas las subcarpetas (en cualquier nivel) — para carpetas "madre" que
 * solo agrupan otras carpetas (ej. una torre con pisos y deptos adentro)
 * y no tienen fotos propias directas, así igual muestran cuánto avance
 * hay adentro de un vistazo.
 */
export async function getPhotoCountByFolderRecursive(folderId) {
  let total = await getPhotoCountByFolder(folderId);
  const children = await getChildFolders(folderId);
  const childCounts = await Promise.all(children.map((c) => getPhotoCountByFolderRecursive(c.id)));
  return total + childCounts.reduce((a, b) => a + b, 0);
}

export async function updatePhoto(id, changes) {
  const store = await tx('photos', 'readwrite');
  const photo = await wrap(store.get(id));
  if (!photo) return null;
  Object.assign(photo, changes);
  await wrap(store.put(photo));
  return photo;
}

export async function deletePhoto(id) {
  const store = await tx('photos', 'readwrite');
  await wrap(store.delete(id));
}

export async function getPhotosByIds(ids) {
  const photos = await Promise.all(ids.map((id) => getPhoto(id)));
  return photos.filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
}

export async function movePhotos(ids, targetFolderId) {
  for (const id of ids) {
    await updatePhoto(id, { folderId: targetFolderId });
  }
}

// ---------- Protocolos: obras ----------

export async function createObra(name) {
  const store = await tx('obras', 'readwrite');
  const now = Date.now();
  const obra = {
    id: uuid(),
    name,
    createdAt: now,
    updatedAt: now,
    driveObraFolderId: null,
    driveObraFolderName: null,
    planosDriveFolderId: null,
    planosDriveFolderName: null,
    signedDriveFolderId: null,
    signedDriveFolderName: null,
  };
  await wrap(store.add(obra));
  return obra;
}

/**
 * Crea o reemplaza una obra completa CON UN ID DADO (no genera uno nuevo)
 * — se usa al sincronizar la lista de obras desde Drive: si Pancho crea
 * "File 589 Loncoche" en su teléfono, el de Jessi debe terminar con una
 * obra local que tenga EXACTAMENTE el mismo id, no una copia con id propio
 * (si no, cada carpeta de Drive vinculada quedaría separada por persona).
 */
export async function upsertObra(obraData) {
  const store = await tx('obras', 'readwrite');
  await wrap(store.put(obraData));
  return obraData;
}

export async function getObra(id) {
  const store = await tx('obras', 'readonly');
  return wrap(store.get(id));
}

export async function getAllObras() {
  const store = await tx('obras', 'readonly');
  const all = await wrap(store.getAll());
  return all.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
}

export async function updateObra(id, changes) {
  const store = await tx('obras', 'readwrite');
  const obra = await wrap(store.get(id));
  if (!obra) return null;
  Object.assign(obra, changes, { updatedAt: Date.now() });
  await wrap(store.put(obra));
  return obra;
}

/**
 * Borra una obra Y TODO lo que cuelga de ella en cualquier módulo
 * (Protocolos, Personal, Checklist + fotos, Avance, Costos, RDI,
 * Subcontratos, Organismos, Informe Semanal) — antes esto solo borraba los
 * protocolos, dejando huérfano (invisible pero ocupando espacio) todo lo
 * demás. Se usa tanto desde el botón "Eliminar obra" como al recibir una
 * tumba (`obraTombstones`) sincronizada desde otro teléfono.
 */
export async function deleteObra(id) {
  const instances = await getInstancesByObra(id);
  for (const instance of instances) {
    await deleteProtocolInstance(instance.id);
  }

  const [ssmaEntries, checklistEntries, checklistTypes, snapshots, modificaciones, facturas, reembolsos, rdis, subcontratos, organismos, informes] = await Promise.all([
    getSSMAEntriesByObra(id),
    getChecklistEntriesByObra(id),
    getChecklistTypesByObra(id),
    getScheduleSnapshotsByObra(id),
    getCostosModificacionesByObra(id),
    getCostosFacturasByObra(id),
    getCostosReembolsosByObra(id),
    getRdiSolicitudesByObra(id),
    getSubcontratosByObra(id),
    getOrganismosTramitesByObra(id),
    getInformesSemanalesByObra(id),
  ]);

  for (const e of ssmaEntries) await deleteSSMAEntry(e.id);
  for (const e of checklistEntries) await deleteChecklistEntry(e.id); // ya borra sus fotos de paso
  for (const t of checklistTypes) {
    const store = await tx('controlChecklistTypes', 'readwrite');
    await wrap(store.delete(t.id));
  }
  for (const s of snapshots) await deleteScheduleSnapshot(s.id);
  for (const m of modificaciones) await deleteCostosModificacion(m.id);
  for (const f of facturas) await deleteCostosFactura(f.id);
  for (const r of reembolsos) await deleteCostosReembolso(r.id);
  for (const r of rdis) await deleteRdiSolicitud(r.id);
  for (const s of subcontratos) await deleteSubcontrato(s.id);
  for (const o of organismos) await deleteOrganismoTramite(o.id);
  for (const inf of informes) await deleteInformeSemanal(inf.id);

  const costosStore = await tx('costosContrato', 'readwrite');
  await wrap(costosStore.delete(id)); // keyPath es obraId directo, no hace falta buscarlo antes

  const store = await tx('obras', 'readwrite');
  await wrap(store.delete(id));
}

// ---------- Tumbas de obras borradas (para que el borrado se propague) ----------

export async function addObraTombstone(id) {
  const store = await tx('obraTombstones', 'readwrite');
  await wrap(store.put({ id, deletedAt: Date.now() }));
}

export async function getObraTombstoneIds() {
  const store = await tx('obraTombstones', 'readonly');
  const all = await wrap(store.getAll());
  return all.map((t) => t.id);
}

// ---------- Protocolos: instancias ----------

export async function createProtocolInstance({ obraId, templateId, templateTitle, header, controlPoints }) {
  const store = await tx('protocolInstances', 'readwrite');
  const now = Date.now();
  const instance = {
    id: uuid(),
    obraId,
    templateId,
    templateTitle,
    status: 'draft', // 'draft' | 'emitted'
    createdAt: now,
    updatedAt: now,
    emittedAt: null,
    header: { obra: '', cliente: '', ubicacion: '', area: '', plano: '', sector: '', ...header },
    // Copia (snapshot) de los puntos de control del template al momento de
    // crear el protocolo — si más adelante se corrige un texto en
    // protocolTemplates.js, los borradores ya empezados no cambian solos.
    controlPoints: controlPoints.map((cp) => ({ label: cp.label, instruction: cp.instruction, status: null })),
    observaciones: '',
    plano: null, // { driveFileId, driveFileName, blob } | null
    signatures: {}, // { [roleId]: { nombre, fecha, signatureBlob } }
    pdfDriveFileId: null,
    pdfDriveFileName: null,
  };
  await wrap(store.add(instance));
  return instance;
}

export async function getProtocolInstance(id) {
  const store = await tx('protocolInstances', 'readonly');
  return wrap(store.get(id));
}

export async function getDraftInstances() {
  const store = await tx('protocolInstances', 'readonly');
  const all = await wrap(store.getAll());
  return all.filter((i) => i.status === 'draft').sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getInstancesByObra(obraId) {
  const store = await tx('protocolInstances', 'readonly');
  const index = store.index('by_obraId');
  const results = await wrap(index.getAll(obraId));
  return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function updateProtocolInstance(id, changes) {
  const store = await tx('protocolInstances', 'readwrite');
  const instance = await wrap(store.get(id));
  if (!instance) return null;
  Object.assign(instance, changes, { updatedAt: Date.now() });
  await wrap(store.put(instance));
  return instance;
}

export async function deleteProtocolInstance(id) {
  const photos = await getProtocolPhotosByInstance(id);
  for (const photo of photos) {
    await deleteProtocolPhoto(photo.id);
  }
  const store = await tx('protocolInstances', 'readwrite');
  await wrap(store.delete(id));
}

// ---------- Protocolos: fotos ----------

export async function addProtocolPhoto({ instanceId, blob }) {
  const store = await tx('protocolPhotos', 'readwrite');
  const photo = { id: uuid(), instanceId, blob, createdAt: Date.now() };
  await wrap(store.add(photo));
  return photo;
}

export async function getProtocolPhotosByInstance(instanceId) {
  const store = await tx('protocolPhotos', 'readonly');
  const index = store.index('by_instanceId');
  const results = await wrap(index.getAll(instanceId));
  return results.sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteProtocolPhoto(id) {
  const store = await tx('protocolPhotos', 'readwrite');
  await wrap(store.delete(id));
}

// ---------- Control: Programación (snapshots de avance importados) ----------

export async function addScheduleSnapshot({ obraId, tasks, overallPercent, scheduleType = 'real', driveFileId = null, driveFileName = null, uploadedAt = Date.now() }) {
  const store = await tx('controlSchedule', 'readwrite');
  const snapshot = {
    id: uuid(),
    obraId,
    // Para archivos que vienen de Drive se usa la fecha de modificación del
    // archivo (no el momento en que la app lo detectó) — así el historial
    // de avance queda ordenado por cuándo se hizo cada revisión de verdad,
    // no por cuándo Pancho abrió la app para que la trajera.
    uploadedAt,
    tasks, // [{ name, plannedStart, plannedEnd, plannedPercent, actualPercent }]
    overallPercent,
    // 'real' (avance físico real en terreno, lo que se lista en la tabla) |
    // 'proyectada' (el plan original, solo alimenta la Curva S del
    // dashboard) — ver computeSCurve en controlDashboard.js.
    scheduleType,
    // Si este snapshot vino de Drive (no de subida manual), se guarda el id
    // del archivo — así "Buscar programación nueva" sabe si ya lo importó.
    driveFileId,
    driveFileName,
  };
  await wrap(store.add(snapshot));
  return snapshot;
}

export async function getScheduleSnapshotsByObra(obraId) {
  const store = await tx('controlSchedule', 'readonly');
  const index = store.index('by_obraId');
  const results = await wrap(index.getAll(obraId));
  return results.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

/** Snapshots de un solo tipo — los de antes de que existiera `scheduleType`
 * (undefined) se tratan como 'real', es lo que Pancho ya venía cargando. */
export async function getScheduleSnapshotsByObraAndType(obraId, type) {
  const all = await getScheduleSnapshotsByObra(obraId);
  return all.filter((s) => (s.scheduleType || 'real') === type);
}

export async function deleteScheduleSnapshot(id) {
  const store = await tx('controlSchedule', 'readwrite');
  await wrap(store.delete(id));
}

// ---------- Control: SSMA (personal en obra por día) ----------

export async function addSSMAEntry({ obraId, date, personalDirecto = 0, personalIndirecto = 0, personalSubcontrato = 0, nota = '', updatedAt }) {
  const store = await tx('controlSSMA', 'readwrite');
  const now = Date.now();
  const entry = {
    id: uuid(),
    obraId,
    date, // 'YYYY-MM-DD'
    personalDirecto,
    personalIndirecto,
    personalSubcontrato,
    nota,
    createdAt: now,
    updatedAt: updatedAt ?? now,
  };
  await wrap(store.add(entry));
  return entry;
}

/**
 * Total de personal de un registro, tolerante a registros viejos (antes de
 * separar Directo/Indirecto, todo se guardaba junto en "personalPropio").
 */
export function ssmaEntryTotal(entry) {
  if (!entry) return 0;
  if (entry.personalDirecto !== undefined || entry.personalIndirecto !== undefined) {
    return (entry.personalDirecto || 0) + (entry.personalIndirecto || 0) + (entry.personalSubcontrato || 0);
  }
  return (entry.personalPropio || 0) + (entry.personalSubcontrato || 0);
}

/** Ídem, separado por categoría — un registro viejo pone todo en "directo". */
export function ssmaEntryBreakdown(entry) {
  if (entry.personalDirecto !== undefined || entry.personalIndirecto !== undefined) {
    return {
      directo: entry.personalDirecto || 0,
      indirecto: entry.personalIndirecto || 0,
      subcontrato: entry.personalSubcontrato || 0,
    };
  }
  return { directo: entry.personalPropio || 0, indirecto: 0, subcontrato: entry.personalSubcontrato || 0 };
}

export async function getSSMAEntriesByObra(obraId) {
  const store = await tx('controlSSMA', 'readonly');
  const index = store.index('by_obraId');
  const results = await wrap(index.getAll(obraId));
  // Más reciente primero.
  return results.sort((a, b) => b.date.localeCompare(a.date));
}

export async function getSSMAEntryByObraAndDate(obraId, date) {
  const entries = await getSSMAEntriesByObra(obraId);
  return entries.find((e) => e.date === date) || null;
}

export async function updateSSMAEntry(id, changes, { updatedAt = Date.now() } = {}) {
  const store = await tx('controlSSMA', 'readwrite');
  const entry = await wrap(store.get(id));
  if (!entry) return null;
  Object.assign(entry, changes, { updatedAt });
  await wrap(store.put(entry));
  return entry;
}

export async function deleteSSMAEntry(id) {
  const store = await tx('controlSSMA', 'readwrite');
  await wrap(store.delete(id));
}

// ---------- Control: tipos de checklist (por obra) ----------
//
// Cada obra tiene su propia lista de "tipos" de checklist diario (por
// defecto: SSMA, Faenas Diarias, Programación — sacados del formato Excel
// real que ya usa el equipo). Los ítems de cada tipo son editables: Faenas
// Diarias en particular cambia según la etapa de la obra (excavaciones,
// hormigones, terminaciones…), así que cada obra puede ajustar su lista.

export async function createChecklistType({ obraId, key, title, items, order = 0 }) {
  const store = await tx('controlChecklistTypes', 'readwrite');
  // Id determinístico (no uuid al azar) en vez de una regla — evita crear
  // un tipo duplicado si esta función se llama dos veces para la misma obra
  // (ej. una carrera al abrir dos pantallas a la vez). OJO: esto NO hace
  // que el id coincida entre el teléfono de Pancho y el de Sergio (cada uno
  // tiene su propio `obraId` local) — por eso la sincronización entre
  // dispositivos (controlSync.js) identifica el tipo por `key`
  // ('ssma'/'faenas'/'programacion'), no por este id.
  const id = `${obraId}:${key}`;
  const existing = await wrap(store.get(id));
  if (existing) return existing;
  const type = {
    id,
    obraId,
    key, // 'ssma' | 'faenas' | 'programacion' | custom
    title,
    // Orden de la pestaña (SSMA, Faenas, Programación…) — no se puede usar
    // `createdAt` para esto: los 3 tipos por defecto se crean en paralelo
    // (Promise.all) y caen en el mismo milisegundo, así que sin este campo
    // el orden de las pestañas salía distinto en cada recarga.
    order,
    items: items.map((it) => ({ id: uuid(), label: it.label, nota: it.nota || '' })),
    createdAt: Date.now(),
  };
  await wrap(store.add(type));
  return type;
}

export async function getChecklistTypesByObra(obraId) {
  const store = await tx('controlChecklistTypes', 'readonly');
  const index = store.index('by_obraId');
  const results = await wrap(index.getAll(obraId));
  return results.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
}

export async function updateChecklistType(id, changes) {
  const store = await tx('controlChecklistTypes', 'readwrite');
  const type = await wrap(store.get(id));
  if (!type) return null;
  Object.assign(type, changes);
  await wrap(store.put(type));
  return type;
}

// ---------- Control: checklist diario (instancias por día) ----------

export async function addChecklistEntry({ obraId, checklistTypeId, date, items, updatedAt }) {
  const store = await tx('controlChecklists', 'readwrite');
  const now = Date.now();
  const entry = {
    id: uuid(),
    obraId,
    checklistTypeId,
    date, // 'YYYY-MM-DD'
    // Copia (snapshot) de los ítems del tipo al momento de crear el
    // checklist del día — si más adelante se edita la lista del tipo, los
    // días ya cargados no cambian solos. Si el ítem ya trae status/resolved
    // (porque viene de un registro sincronizado desde Drive, no de la
    // plantilla del tipo), se respeta en vez de resetear a null/false.
    items: items.map((it) => ({
      itemId: it.itemId ?? it.id,
      label: it.label,
      nota: it.nota || '',
      status: it.status ?? null,
      resolved: it.resolved ?? false,
      observacion: it.observacion || '',
    })),
    createdAt: now,
    updatedAt: updatedAt ?? now,
  };
  await wrap(store.add(entry));
  return entry;
}

export async function getChecklistEntriesByType(checklistTypeId) {
  const store = await tx('controlChecklists', 'readonly');
  const index = store.index('by_typeId');
  const results = await wrap(index.getAll(checklistTypeId));
  return results.sort((a, b) => b.date.localeCompare(a.date));
}

/** Todos los checklists de una obra (los 3 tipos juntos) — para el dashboard. */
export async function getChecklistEntriesByObra(obraId) {
  const store = await tx('controlChecklists', 'readonly');
  const index = store.index('by_obraId');
  const results = await wrap(index.getAll(obraId));
  return results.sort((a, b) => b.date.localeCompare(a.date));
}

export async function getChecklistEntry(id) {
  const store = await tx('controlChecklists', 'readonly');
  return wrap(store.get(id));
}

export async function getChecklistEntryByTypeAndDate(checklistTypeId, date) {
  const entries = await getChecklistEntriesByType(checklistTypeId);
  return entries.find((e) => e.date === date) || null;
}

export async function updateChecklistEntry(id, changes, { updatedAt = Date.now() } = {}) {
  const store = await tx('controlChecklists', 'readwrite');
  const entry = await wrap(store.get(id));
  if (!entry) return null;
  Object.assign(entry, changes, { updatedAt });
  await wrap(store.put(entry));
  return entry;
}

export async function deleteChecklistEntry(id) {
  const photos = await getChecklistPhotosByEntry(id);
  for (const photo of photos) {
    await deleteChecklistPhoto(photo.id);
  }
  const store = await tx('controlChecklists', 'readwrite');
  await wrap(store.delete(id));
}

export async function addChecklistPhoto({ checklistId, blob }) {
  const store = await tx('controlChecklistPhotos', 'readwrite');
  const photo = { id: uuid(), checklistId, blob, createdAt: Date.now() };
  await wrap(store.add(photo));
  return photo;
}

export async function getChecklistPhotosByEntry(checklistId) {
  const store = await tx('controlChecklistPhotos', 'readonly');
  const index = store.index('by_checklistId');
  const results = await wrap(index.getAll(checklistId));
  return results.sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteChecklistPhoto(id) {
  const store = await tx('controlChecklistPhotos', 'readwrite');
  await wrap(store.delete(id));
}

// ---------- Costos: contrato (config, 1 registro por obra) ----------

export async function getCostosContrato(obraId) {
  const store = await tx('costosContrato', 'readonly');
  return wrap(store.get(obraId));
}

/** Crea o reemplaza el contrato de una obra (upsert natural: `keyPath` es
 * `obraId`, así que un mismo `put` sirve para "crear" y "editar"). */
export async function saveCostosContrato({ obraId, presupuestoOficial = 0, montoContrato = 0, moneda = '$', tcContrato = 1, anticipoPct = 0, retencionPeriodoPct = 0, retencionTotalContratoPct = 0, updatedAt }) {
  const store = await tx('costosContrato', 'readwrite');
  const contrato = {
    obraId,
    presupuestoOficial,
    montoContrato,
    moneda,
    tcContrato,
    anticipoPct,
    retencionPeriodoPct,
    retencionTotalContratoPct,
    updatedAt: updatedAt ?? Date.now(),
  };
  await wrap(store.put(contrato));
  return contrato;
}

// ---------- Costos: presupuesto original detallado (1 registro por obra) ----------

export async function getCostosPresupuestoDetalle(obraId) {
  const store = await tx('costosPresupuestoDetalle', 'readonly');
  return wrap(store.get(obraId));
}

/** Reemplaza entero el desglose de partidas de una obra (upsert por `obraId`,
 * igual que costosContrato). `items`: [{categoria, item, descripcion, unidad,
 * cantidad, precioUnitario, total}]. */
export async function saveCostosPresupuestoDetalle({ obraId, items = [], grandTotal = 0, sourceFileName = '', updatedAt }) {
  const store = await tx('costosPresupuestoDetalle', 'readwrite');
  const detalle = {
    obraId,
    items,
    grandTotal,
    sourceFileName,
    updatedAt: updatedAt ?? Date.now(),
  };
  await wrap(store.put(detalle));
  return detalle;
}

export async function deleteCostosPresupuestoDetalle(obraId) {
  const store = await tx('costosPresupuestoDetalle', 'readwrite');
  await wrap(store.delete(obraId));
}

// ---------- Costos: modificaciones de obra (MO) y proformas ----------

/** Total de un desglose costoDirecto/gastosGenerales/utilidad — no se
 * guarda aparte, se calcula siempre desde las 3 partes. */
export function costosMontoTotal(m) {
  if (!m) return 0;
  return (m.costoDirecto || 0) + (m.gastosGenerales || 0) + (m.utilidad || 0);
}

export async function addCostosModificacion({ obraId, numero, descripcion, fechaPresentacion, tipo, subtipo, montoPresentado, estado = 'pendiente', montoAprobado, montoEstimado, observaciones = '', numeroOC = '', causadaPor = '', updatedAt }) {
  const store = await tx('costosModificaciones', 'readwrite');
  const now = Date.now();
  const mo = {
    id: uuid(),
    obraId,
    numero,
    descripcion,
    fechaPresentacion, // 'YYYY-MM-DD'
    tipo, // 'modificacion' | 'proforma'
    subtipo, // 'aumento' | 'disminucion' | 'obraExtraordinaria'
    montoPresentado: { costoDirecto: 0, gastosGenerales: 0, utilidad: 0, ...montoPresentado },
    estado, // 'pendiente' | 'aprobada' | 'rechazada'
    montoAprobado: { costoDirecto: 0, gastosGenerales: 0, utilidad: 0, ...montoAprobado },
    montoEstimado: { costoDirecto: 0, gastosGenerales: 0, utilidad: 0, ...montoEstimado },
    observaciones,
    numeroOC,
    causadaPor,
    createdAt: now,
    updatedAt: updatedAt ?? now,
  };
  await wrap(store.add(mo));
  return mo;
}

/** Crea o reemplaza una modificación CON UN ID DADO (no genera uno nuevo) —
 * se usa al sincronizar desde Drive: el `id` viaja completo dentro del JSON
 * y debe conservarse tal cual, si no cada sincronización crearía un
 * registro duplicado en vez de reconocer el que ya existe (mismo problema
 * que resolvió `upsertObra` para la lista de obras). */
export async function upsertCostosModificacion(mo) {
  const store = await tx('costosModificaciones', 'readwrite');
  await wrap(store.put(mo));
  return mo;
}

export async function getCostosModificacionesByObra(obraId) {
  const store = await tx('costosModificaciones', 'readonly');
  const index = store.index('by_obraId');
  const results = await wrap(index.getAll(obraId));
  return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function updateCostosModificacion(id, changes, { updatedAt = Date.now() } = {}) {
  const store = await tx('costosModificaciones', 'readwrite');
  const mo = await wrap(store.get(id));
  if (!mo) return null;
  Object.assign(mo, changes, { updatedAt });
  await wrap(store.put(mo));
  return mo;
}

export async function deleteCostosModificacion(id) {
  const store = await tx('costosModificaciones', 'readwrite');
  await wrap(store.delete(id));
}

// ---------- Costos: facturación ----------

export async function addCostosFactura({ obraId, tipo, item = '', descripcion = '', numeroFactura = '', fecha, tc = 1, avanceNetoPeriodo = 0, anticipoPeriodo = 0, retencionPeriodo = 0, reajustePeriodo = 0, updatedAt }) {
  const store = await tx('costosFacturas', 'readwrite');
  const now = Date.now();
  const factura = {
    id: uuid(),
    obraId,
    tipo, // 'contractual' | 'modificaciones'
    item,
    descripcion,
    numeroFactura,
    fecha, // 'YYYY-MM-DD'
    tc,
    avanceNetoPeriodo,
    anticipoPeriodo,
    retencionPeriodo,
    reajustePeriodo,
    createdAt: now,
    updatedAt: updatedAt ?? now,
  };
  await wrap(store.add(factura));
  return factura;
}

/** Monto neto de una factura: avance del período menos lo retenido/
 * anticipado, más el reajuste — no se guarda (se calcula siempre desde los
 * montos del período, para no arrastrar un número desincronizado). */
export function costosFacturaMontoNeto(f) {
  if (!f) return 0;
  return (f.avanceNetoPeriodo || 0) - (f.anticipoPeriodo || 0) - (f.retencionPeriodo || 0) + (f.reajustePeriodo || 0);
}

/** Ídem `upsertCostosModificacion`, para facturas sincronizadas desde Drive. */
export async function upsertCostosFactura(factura) {
  const store = await tx('costosFacturas', 'readwrite');
  await wrap(store.put(factura));
  return factura;
}

export async function getCostosFacturasByObra(obraId) {
  const store = await tx('costosFacturas', 'readonly');
  const index = store.index('by_obraId');
  const results = await wrap(index.getAll(obraId));
  return results.sort((a, b) => b.fecha.localeCompare(a.fecha));
}

export async function updateCostosFactura(id, changes, { updatedAt = Date.now() } = {}) {
  const store = await tx('costosFacturas', 'readwrite');
  const factura = await wrap(store.get(id));
  if (!factura) return null;
  Object.assign(factura, changes, { updatedAt });
  await wrap(store.put(factura));
  return factura;
}

export async function deleteCostosFactura(id) {
  const store = await tx('costosFacturas', 'readwrite');
  await wrap(store.delete(id));
}

// ---------- Costos: reembolsos solicitados por la constructora ----------

export async function addCostosReembolso({ obraId, numero = '', descripcion = '', montoSinIva = 0, montoConIva = 0, fechaSolicitud, fechaPago = null, updatedAt }) {
  const store = await tx('costosReembolsos', 'readwrite');
  const now = Date.now();
  const reembolso = {
    id: uuid(),
    obraId,
    numero,
    descripcion,
    montoSinIva,
    montoConIva,
    fechaSolicitud, // 'YYYY-MM-DD'
    fechaPago, // 'YYYY-MM-DD' | null (null = pendiente de pago)
    createdAt: now,
    updatedAt: updatedAt ?? now,
  };
  await wrap(store.add(reembolso));
  return reembolso;
}

/** Ídem `upsertCostosModificacion`, para reembolsos sincronizados desde Drive. */
export async function upsertCostosReembolso(reembolso) {
  const store = await tx('costosReembolsos', 'readwrite');
  await wrap(store.put(reembolso));
  return reembolso;
}

export async function getCostosReembolsosByObra(obraId) {
  const store = await tx('costosReembolsos', 'readonly');
  const index = store.index('by_obraId');
  const results = await wrap(index.getAll(obraId));
  return results.sort((a, b) => b.fechaSolicitud.localeCompare(a.fechaSolicitud));
}

export async function updateCostosReembolso(id, changes, { updatedAt = Date.now() } = {}) {
  const store = await tx('costosReembolsos', 'readwrite');
  const reembolso = await wrap(store.get(id));
  if (!reembolso) return null;
  Object.assign(reembolso, changes, { updatedAt });
  await wrap(store.put(reembolso));
  return reembolso;
}

export async function deleteCostosReembolso(id) {
  const store = await tx('costosReembolsos', 'readwrite');
  await wrap(store.delete(id));
}

// ---------- RDI: requerimientos de información al mandante ----------

export async function addRdiSolicitud({ obraId, numero = '', fecha, emisor = '', cargo = '', especialidad = '', elementoArea = '', planoDocumento = '', descripcion = '', antecedentesAdjuntos = false, fechaEnvio, fechaRecepcion = null, respuesta = '', respuestaValida = null, accion = '', updatedAt }) {
  const store = await tx('rdiSolicitudes', 'readwrite');
  const now = Date.now();
  const rdi = {
    id: uuid(),
    obraId,
    numero,
    fecha, // 'YYYY-MM-DD' — fecha en que se detecta/redacta el RDI
    emisor,
    cargo,
    especialidad,
    elementoArea,
    planoDocumento,
    descripcion,
    antecedentesAdjuntos,
    fechaEnvio, // 'YYYY-MM-DD' — cuándo se envió al mandante
    fechaRecepcion, // 'YYYY-MM-DD' | null — cuándo llegó la respuesta (null = pendiente)
    respuesta,
    respuestaValida, // true | false | null (null = todavía no evaluada / no aplica)
    accion,
    createdAt: now,
    updatedAt: updatedAt ?? now,
  };
  await wrap(store.add(rdi));
  return rdi;
}

/** Crea o reemplaza un RDI CON UN ID DADO — se usa al sincronizar desde
 * Drive, mismo motivo que `upsertCostosModificacion`. */
export async function upsertRdiSolicitud(rdi) {
  const store = await tx('rdiSolicitudes', 'readwrite');
  await wrap(store.put(rdi));
  return rdi;
}

export async function getRdiSolicitudesByObra(obraId) {
  const store = await tx('rdiSolicitudes', 'readonly');
  const index = store.index('by_obraId');
  const results = await wrap(index.getAll(obraId));
  return results.sort((a, b) => b.fechaEnvio.localeCompare(a.fechaEnvio));
}

export async function updateRdiSolicitud(id, changes, { updatedAt = Date.now() } = {}) {
  const store = await tx('rdiSolicitudes', 'readwrite');
  const rdi = await wrap(store.get(id));
  if (!rdi) return null;
  Object.assign(rdi, changes, { updatedAt });
  await wrap(store.put(rdi));
  return rdi;
}

export async function deleteRdiSolicitud(id) {
  const store = await tx('rdiSolicitudes', 'readwrite');
  await wrap(store.delete(id));
}

// ---------- Subcontratos (directorio) ----------

export async function addSubcontrato({ obraId, numero = '', razonSocial = '', servicio = '', rut = '', contacto = '', fono = '', email = '', activo = true, updatedAt }) {
  const store = await tx('subcontratos', 'readwrite');
  const now = Date.now();
  const sub = {
    id: uuid(),
    obraId,
    numero,
    razonSocial,
    servicio,
    rut,
    contacto,
    fono,
    email,
    activo,
    createdAt: now,
    updatedAt: updatedAt ?? now,
  };
  await wrap(store.add(sub));
  return sub;
}

/** Ídem `upsertCostosModificacion` — conserva el `id` al sincronizar desde Drive. */
export async function upsertSubcontrato(sub) {
  const store = await tx('subcontratos', 'readwrite');
  await wrap(store.put(sub));
  return sub;
}

export async function getSubcontratosByObra(obraId) {
  const store = await tx('subcontratos', 'readonly');
  const index = store.index('by_obraId');
  const results = await wrap(index.getAll(obraId));
  return results.sort((a, b) => (a.razonSocial || '').localeCompare(b.razonSocial || '', 'es', { numeric: true }));
}

export async function updateSubcontrato(id, changes, { updatedAt = Date.now() } = {}) {
  const store = await tx('subcontratos', 'readwrite');
  const sub = await wrap(store.get(id));
  if (!sub) return null;
  Object.assign(sub, changes, { updatedAt });
  await wrap(store.put(sub));
  return sub;
}

export async function deleteSubcontrato(id) {
  const store = await tx('subcontratos', 'readwrite');
  await wrap(store.delete(id));
}

// ---------- Organismos públicos (estado de trámites) ----------

export async function addOrganismoTramite({ obraId, item = '', gestion = '', organismo = '', aprobado = false, pagoDerechos = false, designacionITO = false, observaciones = '', fechaEstimada = null, fechaEntregada = null, updatedAt }) {
  const store = await tx('organismosPublicos', 'readwrite');
  const now = Date.now();
  const tramite = {
    id: uuid(),
    obraId,
    item,
    gestion,
    organismo,
    aprobado,
    pagoDerechos,
    designacionITO,
    observaciones,
    fechaEstimada, // 'YYYY-MM-DD' | null
    fechaEntregada, // 'YYYY-MM-DD' | null
    createdAt: now,
    updatedAt: updatedAt ?? now,
  };
  await wrap(store.add(tramite));
  return tramite;
}

/** Ídem `upsertCostosModificacion` — conserva el `id` al sincronizar desde Drive. */
export async function upsertOrganismoTramite(tramite) {
  const store = await tx('organismosPublicos', 'readwrite');
  await wrap(store.put(tramite));
  return tramite;
}

export async function getOrganismosTramitesByObra(obraId) {
  const store = await tx('organismosPublicos', 'readonly');
  const index = store.index('by_obraId');
  const results = await wrap(index.getAll(obraId));
  return results.sort((a, b) => (a.item || '').localeCompare(b.item || '', 'es', { numeric: true }));
}

export async function updateOrganismoTramite(id, changes, { updatedAt = Date.now() } = {}) {
  const store = await tx('organismosPublicos', 'readwrite');
  const tramite = await wrap(store.get(id));
  if (!tramite) return null;
  Object.assign(tramite, changes, { updatedAt });
  await wrap(store.put(tramite));
  return tramite;
}

export async function deleteOrganismoTramite(id) {
  const store = await tx('organismosPublicos', 'readwrite');
  await wrap(store.delete(id));
}

// ---------- Informe Semanal ----------

export async function createInformeSemanal({ obraId, fecha, lugar = '', horaInicio = '', reunionTitulo = '' }) {
  const store = await tx('informesSemanales', 'readwrite');
  const now = Date.now();
  const informe = {
    id: uuid(),
    obraId,
    fecha, // 'YYYY-MM-DD'
    lugar,
    horaInicio,
    reunionTitulo,
    participantesConstructora: [], // [{ nombre, cargo, iniciales, firmaBlob }]
    participantesLen: [],
    temas: [], // [{ punto, responsable }]
    status: 'draft', // 'draft' | 'emitted'
    pdfDriveFileId: null,
    pdfDriveFileName: null,
    createdAt: now,
    updatedAt: now,
  };
  await wrap(store.add(informe));
  return informe;
}

export async function getInformeSemanal(id) {
  const store = await tx('informesSemanales', 'readonly');
  return wrap(store.get(id));
}

export async function getInformesSemanalesByObra(obraId) {
  const store = await tx('informesSemanales', 'readonly');
  const index = store.index('by_obraId');
  const results = await wrap(index.getAll(obraId));
  return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function updateInformeSemanal(id, changes) {
  const store = await tx('informesSemanales', 'readwrite');
  const informe = await wrap(store.get(id));
  if (!informe) return null;
  Object.assign(informe, changes, { updatedAt: Date.now() });
  await wrap(store.put(informe));
  return informe;
}

export async function deleteInformeSemanal(id) {
  const store = await tx('informesSemanales', 'readwrite');
  await wrap(store.delete(id));
}

/** Todas las fotos del Checklist diario (SSMA/Faenas/Programación juntos)
 * de una obra, cargadas en checklists con fecha dentro de [fromDate,
 * toDate] (inclusive, 'YYYY-MM-DD') — para el compilado del Informe
 * Semanal, que saca sus fotos de ahí en vez de tener captura propia. */
export async function getChecklistPhotosInRange(obraId, fromDate, toDate) {
  const entries = await getChecklistEntriesByObra(obraId);
  const inRange = entries.filter((e) => e.date >= fromDate && e.date <= toDate);
  const photosByEntry = await Promise.all(inRange.map((e) => getChecklistPhotosByEntry(e.id)));
  return photosByEntry.flat().sort((a, b) => a.createdAt - b.createdAt);
}
