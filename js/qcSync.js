// Sincronización del módulo Control de calidad con Drive.
//
// Cada cambio es un evento (ver qcStore.js) y cada evento es un archivo .json
// propio dentro de la carpeta del proyecto en Drive — nunca se reemplaza ni se
// borra ninguno, así que dos personas trabajando a la vez no se pisan: cada
// aparato sube los suyos y baja los que le faltan. El estado final sale de
// aplicar todos los eventos, y gana siempre el cambio más nuevo de cada campo.
//
//   CONTROL DE CALIDAD/
//     <nombre del proyecto> [primeros 8 caracteres del id]/
//       eventos/   ->  <hora>_<id>.json
import {
  DEFAULT_ROOT_FOLDER,
  findOrCreateDriveFolder,
  listDriveFolders,
  listDriveFilesAll,
  uploadFile,
  downloadDriveFile,
  isSignedIn,
} from './googleDrive.js';
import { qcGetEventsByProject, qcGetAllEventIds } from './db.js';
import { qcIngestEvent, qcLoadProject, qcListProjects, onQcCommit } from './qcStore.js';

const ROOT_FOLDER_NAME = 'CONTROL DE CALIDAD';
const EVENTS_FOLDER_NAME = 'eventos';
const CACHE_KEY = 'qc-drive-folders-v1';

const changeListeners = new Set();

/** Avisa cuando llegaron cambios de otras personas (para repintar la pantalla). */
export function onQcChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function notifyChange(info) {
  changeListeners.forEach((fn) => fn(info));
}

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // sin localStorage: se vuelve a buscar la carpeta cada vez
  }
}

const idPrefix = (projectId) => projectId.slice(0, 8);

function safeFolderName(name) {
  return String(name || 'Proyecto').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 60) || 'Proyecto';
}

let rootFolderId = null;
async function getRootFolderId() {
  if (rootFolderId) return rootFolderId;
  const folder = await findOrCreateDriveFolder(DEFAULT_ROOT_FOLDER.id, ROOT_FOLDER_NAME);
  rootFolderId = folder.id;
  return rootFolderId;
}

/**
 * Carpeta "eventos" de un proyecto. Se busca por el código entre corchetes del
 * final del nombre (no por el nombre completo): así renombrar el proyecto no
 * crea una carpeta duplicada. Si no existe, se crea.
 */
async function getEventsFolderId(projectId, projectName) {
  const cache = readCache();
  if (cache[projectId]) return cache[projectId];
  const root = await getRootFolderId();
  const folders = await listDriveFolders(root);
  const tag = `[${idPrefix(projectId)}]`;
  let projectFolder = folders.find((f) => f.name.trim().endsWith(tag));
  if (!projectFolder) projectFolder = await findOrCreateDriveFolder(root, `${safeFolderName(projectName)} ${tag}`);
  const eventsFolder = await findOrCreateDriveFolder(projectFolder.id, EVENTS_FOLDER_NAME);
  cache[projectId] = eventsFolder.id;
  writeCache(cache);
  return eventsFolder.id;
}

function eventIdFromFileName(name) {
  const m = name.match(/^\d+_(.+)\.json$/);
  return m ? m[1] : null;
}

/** Baja de una carpeta "eventos" los eventos que este aparato todavía no tiene. */
async function pullEvents(eventsFolderId, knownIds) {
  const remote = await listDriveFilesAll(eventsFolderId);
  const missing = remote.filter((f) => {
    const id = eventIdFromFileName(f.name);
    return id && !knownIds.has(id);
  });
  let pulled = 0;
  const rejected = [];
  const projects = new Set();
  for (const file of missing) {
    try {
      const event = JSON.parse(await (await downloadDriveFile(file.id)).text());
      if (await qcIngestEvent(event)) {
        pulled++;
        projects.add(event.projectId);
      }
    } catch (err) {
      console.error(`No se pudo traer el evento ${file.name}:`, err);
      rejected.push(file.name);
    }
  }
  return { pulled, rejected, projects, remoteIds: new Set(remote.map((f) => eventIdFromFileName(f.name)).filter(Boolean)) };
}

const running = new Map();

/** Sube y baja los eventos de UN proyecto. Nunca pide sesión: si no hay, no hace nada. */
export function qcSyncProject(projectId) {
  if (running.has(projectId)) return running.get(projectId);
  const job = (async () => {
    if (!isSignedIn() || !navigator.onLine) return { pulled: 0, pushed: 0, rejected: [], skipped: true };
    const { proyecto } = await qcLoadProject(projectId);
    const eventsFolderId = await getEventsFolderId(projectId, proyecto?.nombre);

    const local = await qcGetEventsByProject(projectId);
    const localIds = new Set(local.map((e) => e.id));
    const { pulled, rejected, remoteIds } = await pullEvents(eventsFolderId, localIds);

    let pushed = 0;
    for (const event of local) {
      if (remoteIds.has(event.id)) continue;
      const blob = new Blob([JSON.stringify(event)], { type: 'application/json' });
      await uploadFile(eventsFolderId, blob, `${event.ts}_${event.id}.json`);
      pushed++;
    }
    if (pulled) notifyChange({ projectId, pulled });
    return { pulled, pushed, rejected };
  })()
    .catch((err) => {
      console.error('Error sincronizando el proyecto de calidad:', err);
      // Si la carpeta guardada ya no existe, se vuelve a buscar la próxima vez.
      const cache = readCache();
      delete cache[projectId];
      writeCache(cache);
      return { pulled: 0, pushed: 0, rejected: [], error: err.message || String(err) };
    })
    .finally(() => running.delete(projectId));
  running.set(projectId, job);
  return job;
}

/**
 * Busca en Drive todos los proyectos de calidad (incluidos los que creó otra
 * persona y este aparato todavía no tiene), baja sus eventos y sube los
 * propios. Devuelve cuántos cambios llegaron.
 */
export async function qcSyncAll() {
  if (!isSignedIn() || !navigator.onLine) return { pulled: 0, skipped: true };
  try {
    const root = await getRootFolderId();
    const folders = await listDriveFolders(root);
    let pulledTotal = 0;
    const touched = new Set();
    // Eventos que este aparato ya tiene: solo se bajan los que faltan.
    const known = new Set(await qcGetAllEventIds());
    for (const folder of folders) {
      const tag = folder.name.trim().match(/\[([0-9a-f]{8})\]$/i)?.[1];
      if (!tag) continue; // no es una carpeta de proyecto de calidad
      const sub = await listDriveFolders(folder.id);
      const eventsFolder = sub.find((f) => f.name.trim().toLowerCase() === EVENTS_FOLDER_NAME);
      if (!eventsFolder) continue;
      const { pulled, projects } = await pullEvents(eventsFolder.id, known);
      pulledTotal += pulled;
      projects.forEach((id) => touched.add(id));
    }
    // Sube lo propio de los proyectos que ya existen aquí.
    for (const p of await qcListProjects()) await qcSyncProject(p.id);
    if (pulledTotal) notifyChange({ pulled: pulledTotal, projects: [...touched] });
    return { pulled: pulledTotal };
  } catch (err) {
    console.error('Error buscando proyectos de calidad en Drive:', err);
    return { pulled: 0, error: err.message || String(err) };
  }
}

// Cada cambio propio se sube solo, unos segundos después (si hay sesión).
const timers = new Map();
onQcCommit((event) => {
  clearTimeout(timers.get(event.projectId));
  timers.set(
    event.projectId,
    setTimeout(() => {
      timers.delete(event.projectId);
      qcSyncProject(event.projectId);
    }, 2500)
  );
});
