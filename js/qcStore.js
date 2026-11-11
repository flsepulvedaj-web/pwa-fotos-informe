// Datos del módulo Control de calidad de proyectos.
//
// Todo cambio es un EVENTO que solo se agrega: nunca se edita ni se borra.
// El estado actual de cada tabla (proyectos, etapas, observaciones…) sale de
// aplicar los eventos en orden. Cada evento lleva quién lo hizo, cuándo, y la
// "huella" (hash) del evento anterior que conocía quien lo creó, así que si
// alguien altera un evento viejo, la cadena deja de calzar y se nota
// (qcVerifyChain). Eso hace el historial "a prueba de alteración visible":
// no impide que alguien con acceso a los archivos los modifique, pero no
// puede hacerlo sin dejar rastro.
//
// Lo que no sirve no se borra: se anula con un motivo (op 'void').
import { uuid } from './utils.js';
import { getSignedInEmail } from './googleDrive.js';
import { qcCommitEvent, qcGetEventsByProject, qcGetRecordsByProject, qcGetRecordsByTable } from './db.js';

export const QC_TABLES = ['proyectos', 'participantes', 'etapas', 'entregas', 'actividades', 'observaciones', 'certificaciones', 'catalogos'];

const LAST_EMAIL_KEY = 'qc-last-email';

/** Correo de quien hace el cambio. Sin internet se usa el último conocido. */
export async function qcAuthor() {
  let email = null;
  try {
    email = await getSignedInEmail();
  } catch {
    email = null;
  }
  try {
    if (email) localStorage.setItem(LAST_EMAIL_KEY, email);
    else email = localStorage.getItem(LAST_EMAIL_KEY);
  } catch {
    // sin localStorage
  }
  return email || 'sin-sesion';
}

/** JSON con las llaves ordenadas: así el hash da igual en cualquier aparato. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function eventBody(event) {
  const { id, projectId, ts, author, note, ops, prev } = event;
  return { id, projectId, ts, author, note, ops, prev };
}

/** Une las operaciones repetidas sobre el mismo registro (se aplican en una sola pasada). */
function mergeOps(ops) {
  const byKey = new Map();
  for (const op of ops) {
    const key = `${op.table}|${op.id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...op, patch: op.patch ? { ...op.patch } : undefined });
    } else if (existing.op === 'set' && op.op === 'set') {
      existing.patch = { ...existing.patch, ...op.patch };
    } else {
      throw new Error(`Operaciones incompatibles sobre ${key}`);
    }
  }
  return [...byKey.values()];
}

// Los cambios se guardan de a uno: así cada evento enlaza con el anterior.
let commitChain = Promise.resolve();

/**
 * Guarda un cambio como evento. `ops`: [{ op: 'set', table, id, patch }] o
 * [{ op: 'void', table, id, reason }].
 */
export function qcCommit(projectId, ops, note = '') {
  const run = commitChain.then(async () => {
    const existing = await qcGetEventsByProject(projectId);
    const last = existing.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)).pop();
    const event = {
      id: uuid(),
      projectId,
      ts: Date.now(),
      author: await qcAuthor(),
      note,
      ops: mergeOps(ops),
      prev: last ? last.hash : null,
    };
    event.hash = await sha256Hex(stableStringify(eventBody(event)));
    await qcCommitEvent(event);
    return event;
  });
  commitChain = run.catch(() => {});
  return run;
}

/** Aplica un evento que vino de otro aparato (sincronización). Verifica su huella. */
export async function qcIngestEvent(event) {
  const expected = await sha256Hex(stableStringify(eventBody(event)));
  if (expected !== event.hash) throw new Error(`El evento ${event.id} no calza con su huella: fue alterado.`);
  return qcCommitEvent(event);
}

/** Recorre todo el historial de un proyecto y avisa si algún evento fue alterado o falta uno. */
export async function qcVerifyChain(projectId) {
  const events = await qcGetEventsByProject(projectId);
  const hashes = new Set(events.map((e) => e.hash));
  const problemas = [];
  for (const e of events) {
    const expected = await sha256Hex(stableStringify(eventBody(e)));
    if (expected !== e.hash) problemas.push({ id: e.id, motivo: 'contenido alterado' });
    else if (e.prev && !hashes.has(e.prev)) problemas.push({ id: e.id, motivo: 'falta el evento anterior' });
  }
  return { ok: problemas.length === 0, total: events.length, problemas };
}

export async function qcHistory(projectId) {
  const events = await qcGetEventsByProject(projectId);
  return events.sort((a, b) => b.ts - a.ts);
}

function flatten(record) {
  return {
    ...record.data,
    id: record.id,
    anulado: !!record.anulado,
    motivoAnulacion: record.motivoAnulacion || '',
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

/**
 * Proyectos de calidad (sin los anulados). Con `obraId` solo los de esa obra
 * de Control; sin él, todos (ej. para quien es invitado a un proyecto sin
 * tener acceso a las obras).
 */
export async function qcListProjects(obraId) {
  const records = await qcGetRecordsByTable('proyectos');
  return records
    .filter((r) => !r.anulado)
    .map(flatten)
    .filter((p) => obraId === undefined || p.obraId === obraId)
    .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es', { numeric: true }));
}

/**
 * Carga un proyecto completo: sus tablas ya separadas. Los registros anulados
 * se mantienen en la lista (con `anulado: true`) para poder mostrarlos tachados;
 * quien los use decide si los oculta.
 */
export async function qcLoadProject(projectId) {
  const records = await qcGetRecordsByProject(projectId);
  const data = { proyecto: null, participantes: [], etapas: [], entregas: [], actividades: [], observaciones: [], certificaciones: [], catalogos: {} };
  for (const r of records) {
    const flat = flatten(r);
    if (r.table === 'proyectos') data.proyecto = flat;
    else if (r.table === 'catalogos') data.catalogos[r.id] = flat.items || [];
    else if (data[r.table]) data[r.table].push(flat);
  }
  const byOrden = (a, b) => (a.orden ?? 0) - (b.orden ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0);
  data.etapas.sort(byOrden);
  data.actividades.sort(byOrden);
  data.participantes.sort((a, b) => (a.rol || '').localeCompare(b.rol || '') || (a.nombre || '').localeCompare(b.nombre || '', 'es'));
  return data;
}

/** Crea un proyecto nuevo con todas sus tablas iniciales en un solo evento. */
export async function qcCreateProject(projectData, extraOps = [], note = 'Proyecto creado') {
  const projectId = uuid();
  const ops = [
    { op: 'set', table: 'proyectos', id: projectId, patch: { estado: 'activo', ...projectData } },
    ...extraOps,
  ];
  await qcCommit(projectId, ops, note);
  return projectId;
}

export function qcNewId() {
  return uuid();
}
