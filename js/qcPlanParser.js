// Lector de planes de control de calidad en Word (.docx).
//
// Un .docx es un zip con XML adentro. Se abre acá mismo (sin librerías) y se
// leen sus TABLAS: cada tipo de tabla se reconoce por los títulos de sus
// columnas, no por su posición ni por el cliente. Por ejemplo, una tabla con
// las columnas "N° | Actividad de control | Responsable | Plazo" es una etapa
// del plan y su título (primera fila) dice cuál. El texto suelto del
// documento (objetivo, alcance…) no se lee.
import { parsePlazo } from './qcDates.js';
import { catalogOps, DEFAULT_ESPECIALIDADES } from './qcTemplates.js';
import { qcNewId } from './qcStore.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

// ---------- 1. Abrir el .docx ----------

function u16(view, o) {
  return view.getUint16(o, true);
}
function u32(view, o) {
  return view.getUint32(o, true);
}

/** Saca un archivo del zip. Devuelve un Uint8Array o null si no está. */
async function zipReadEntry(buffer, wantedName) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Fin del directorio central (firma 0x06054b50), buscado desde el final.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
    if (u32(view, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('El archivo no es un .docx válido (no se pudo abrir).');

  const entries = u16(view, eocd + 10);
  let p = u32(view, eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (u32(view, p) !== 0x02014b50) break;
    const method = u16(view, p + 10);
    const compressedSize = u32(view, p + 20);
    const nameLen = u16(view, p + 28);
    const extraLen = u16(view, p + 30);
    const commentLen = u16(view, p + 32);
    const localOffset = u32(view, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (name === wantedName) {
      const lNameLen = u16(view, localOffset + 26);
      const lExtraLen = u16(view, localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = bytes.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      throw new Error('El .docx usa una compresión no soportada.');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// ---------- 2. Leer las tablas ----------

function cellText(tc) {
  const parts = [];
  for (const p of tc.getElementsByTagNameNS(W_NS, 'p')) {
    let text = '';
    for (const node of p.getElementsByTagNameNS(W_NS, '*')) {
      if (node.localName === 't') text += node.textContent;
      else if (node.localName === 'tab' || node.localName === 'br') text += ' ';
    }
    if (text.trim()) parts.push(text.trim());
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Tablas del documento: [{ rows: [[texto de cada celda]] }] */
export function extractTables(documentXml) {
  const doc = new DOMParser().parseFromString(documentXml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('No se pudo leer el contenido del documento.');
  const body = doc.getElementsByTagNameNS(W_NS, 'body')[0];
  const tables = [];
  for (const node of body.children) {
    if (node.localName !== 'tbl') continue;
    const rows = [];
    for (const tr of node.children) {
      if (tr.localName !== 'tr') continue;
      const cells = [];
      for (const tc of tr.children) if (tc.localName === 'tc') cells.push(cellText(tc));
      rows.push(cells);
    }
    tables.push({ rows });
  }
  return tables;
}

// ---------- 3. Entender cada tabla ----------

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const isPlaceholder = (s) => /^\s*\[/.test(s || '');
// Los textos "[completar…]" son campos que el documento deja para llenar: se
// quitan (también cuando vienen al final de un valor, ej. "Versión 1, [fecha]").
const cleanValue = (s) => (isPlaceholder(s) ? '' : (s || '').replace(/\s*,?\s*\[[^\]]*\]/g, '').trim());

function classifyTable(table) {
  const headerIdx = table.rows.findIndex((r) => r.length >= 2);
  if (headerIdx < 0) return null;
  const header = table.rows[headerIdx].map(norm);
  const title = table.rows[0].length === 1 ? table.rows[0][0] : '';
  const dataRows = table.rows.slice(headerIdx + 1);
  const h = header.join('|');
  let kind = null;
  if (header[0] === 'n' && header.includes('actividad de control')) kind = 'actividades';
  else if (h.startsWith('paso|accion')) kind = 'proceso';
  else if (h.startsWith('categoria|descripcion')) kind = 'categorias';
  else if (h.startsWith('rol|nombre')) kind = 'roles';
  else if (h === 'campo|detalle') kind = 'datos';
  else if (h === 'campo|contenido') kind = 'matriz';
  else if (h.startsWith('indicador|meta')) kind = 'indicadores';
  else if (h.startsWith('accion de control|se inicia con')) kind = 'secuencia';
  return kind ? { kind, title, rows: dataRows } : null;
}

const ROLE_BY_TEXT = [
  [/pml|responsable del plan|responsable del proyecto/, 'responsable'],
  [/asistente|revisor/, 'revisor'],
  [/asesor/, 'asesor'],
  [/gobernanza|gerencia/, 'gobernanza'],
  [/dise[nñ]ador|contratista|revisado/, 'revisado'],
  [/banco|mandante|pmb|acr/, 'mandante'],
];

function roleIdFromText(text) {
  const t = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const hit = ROLE_BY_TEXT.find(([re]) => re.test(t));
  return hit ? hit[1] : null;
}

function capitalizeFirst(s) {
  const t = s.trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function parseStageTitle(title) {
  // "Entregable 3 y 3.2: Diseño esquemático ... (semanas 3 a 8, Anexo A2)"
  const m = title.match(/^Entregables?\s+(.+?):\s*(.*?)\s*\(([^()]*)\)\s*$/i) || title.match(/^Entregables?\s+(.+?):\s*(.*)$/i);
  if (!m) return { nombre: title.trim(), semana: '', referencia: '' };
  const detail = m[3] || '';
  const semana = detail.match(/semanas?\s+\d+(?:\s*a\s*\d+)?/i)?.[0] || '';
  const referencia = detail.match(/Anexo\s+\w+/i)?.[0] || '';
  return { nombre: capitalizeFirst(m[2]), semana, referencia };
}

/**
 * Convierte las tablas de un plan en un proyecto listo para cargar.
 * Devuelve { ok, error?, proyecto, participantes, etapas, catalogos, pendientes, resumen }.
 */
export function parseQualityPlan(tables) {
  const found = { actividades: [] };
  for (const t of tables) {
    const c = classifyTable(t);
    if (!c) continue;
    if (c.kind === 'actividades') found.actividades.push(c);
    else if (!found[c.kind]) found[c.kind] = c;
  }

  if (!found.actividades.length) {
    return {
      ok: false,
      error: 'No encontré tablas de actividades. Cada etapa tiene que ser una tabla con las columnas "N° | Actividad de control | Responsable | Plazo".',
    };
  }

  const pendientes = [];

  // Datos generales del proyecto
  const dato = (campo) => {
    const row = (found.datos?.rows || []).find((r) => norm(r[0]) === norm(campo));
    const raw = row?.[1] || '';
    if (isPlaceholder(raw)) pendientes.push(`${campo}: falta completar`);
    return cleanValue(raw);
  };
  const nombre = dato('Proyecto');
  const proyecto = {
    nombre: nombre || 'Proyecto sin nombre',
    codigo: nombre.match(/SDP\s*N[°º]?\s*([\w-]+)/i) ? `SDP ${nombre.match(/SDP\s*N[°º]?\s*([\w-]+)/i)[1]}` : '',
    mandante: dato('Mandante'),
    contraparte: dato('Contraparte del Banco'),
    pml: dato('PML'),
    disenador: dato('Diseñador'),
    contrato: dato('Contrato PML'),
    versionPlan: dato('Versión del plan'),
    tipo: 'Revisión de diseño',
  };

  // Plazos de revisión por etapa: de la tabla "Secuencia" y del "Proceso"
  const procesoRows = found.proceso?.rows || [];
  // Solo el nombre del paso: la fila "Completitud" también menciona la
  // "revisión técnica" en su descripción y tiene otro plazo.
  const pasoRevision = procesoRows.find((r) => /revision tecnica/.test(norm(r[0])));
  const plazoRevisionBase = parsePlazo(pasoRevision?.[3] || '');
  const plazoRevisionDefault = plazoRevisionBase.tipo === 'recepcion' ? plazoRevisionBase.hasta : 10;
  const diasPorEtapa = {};
  for (const r of found.secuencia?.rows || []) {
    const stage = /inicio del servicio/i.test(r[1] || '') ? '0' : (r[1] || '').match(/Entregables?\s+(\d+)/i)?.[1];
    const dias = (r[2] || '').match(/(\d+)\s+d[ií]as\s+h[aá]biles/i)?.[1];
    if (stage && dias) diasPorEtapa[stage] = Number(dias);
  }

  // Etapas y actividades
  const etapas = found.actividades.map((t, i) => {
    const acts = t.rows.filter((r) => /^\d+\.\d+$/.test((r[0] || '').trim()));
    const codigo = acts[0] ? acts[0][0].split('.')[0] : String(i);
    const parsed = parseStageTitle(t.title);
    const hitos = acts.flatMap((r) => [...(r[1] || '').matchAll(/Hito\s+([\d.]+)/gi)].map((m) => m[1]));
    return {
      codigo,
      nombre: parsed.nombre,
      tituloOriginal: t.title,
      semana: parsed.semana,
      referencia: parsed.referencia,
      hito: hitos.length ? `Hito ${hitos[hitos.length - 1]}` : '',
      orden: i + 1,
      // La etapa 0 (inicio del servicio) no es una entrega que se revise.
      plazoRevisionDias: codigo === '0' ? null : (diasPorEtapa[codigo] ?? plazoRevisionDefault),
      actividades: acts.map((r, j) => ({
        codigo: r[0].trim(),
        descripcion: r[1] || '',
        responsableTexto: r[2] || '',
        responsableRol: roleIdFromText(r[2]),
        plazoTexto: r[3] || '',
        plazoParseado: parsePlazo(r[3]),
        orden: j + 1,
      })),
    };
  });

  // Participantes
  const participantes = (found.roles?.rows || []).map((r) => {
    const rol = roleIdFromText(r[0]);
    const nombrePersona = cleanValue(r[1]);
    if (!nombrePersona) pendientes.push(`${r[0]}: falta el nombre`);
    let empresa = '';
    if (['responsable', 'revisor', 'asesor', 'gobernanza'].includes(rol)) empresa = proyecto.pml;
    else if (rol === 'revisado') empresa = proyecto.disenador;
    else if (rol === 'mandante') empresa = proyecto.mandante;
    return {
      rol,
      cargo: r[0],
      nombre: nombrePersona,
      empresa,
      correo: '',
      descripcionRol: r[2] || '',
      pendiente: !nombrePersona,
    };
  });

  // Catálogos
  const categorias = (found.categorias?.rows || []).map((r) => {
    const m = (r[0] || '').match(/^([A-Za-z])\.?\s*(.*)$/);
    const tratamiento = r[2] || '';
    return {
      codigo: (m?.[1] || r[0] || '').toUpperCase(),
      nombre: m?.[2] || '',
      descripcion: r[1] || '',
      tratamiento,
      bloquea: /impide/i.test(tratamiento) ? 'abiertas' : /re-?entrega/i.test(tratamiento) ? 'sin_solucion' : 'no',
    };
  });

  const espRow = (found.matriz?.rows || []).find((r) => norm(r[0]) === 'especialidad');
  const especialidades = espRow
    ? espRow[1].split(/,| o /).map((s) => capitalizeFirst(s)).filter(Boolean).map((nombreEsp) => ({ nombre: nombreEsp }))
    : DEFAULT_ESPECIALIDADES.map((n) => ({ nombre: n }));

  const indicadores = (found.indicadores?.rows || []).map((r) => ({ indicador: r[0], meta: r[1], reporte: r[2] }));
  const procesoRevision = procesoRows.map((r) => ({ paso: r[0], accion: r[1], responsable: r[2], plazo: r[3] }));

  const totalActividades = etapas.reduce((s, e) => s + e.actividades.length, 0);
  const calculables = etapas.flatMap((e) => e.actividades).filter((a) => ['recepcion', 'paralelo', 'inicio'].includes(a.plazoParseado.tipo)).length;

  return {
    ok: true,
    proyecto,
    participantes,
    etapas,
    catalogos: {
      ...(categorias.length ? { categorias } : {}),
      especialidades,
      ...(indicadores.length ? { indicadores } : {}),
      ...(procesoRevision.length ? { procesoRevision } : {}),
    },
    pendientes,
    resumen: {
      etapas: etapas.length,
      actividades: totalActividades,
      conFechaCalculable: calculables,
      participantes: participantes.length,
      categorias: categorias.length,
      especialidades: especialidades.length,
    },
  };
}

/** Abre un .docx (ArrayBuffer) y lee el plan que trae. */
export async function parseQualityPlanDocx(arrayBuffer) {
  const xml = await zipReadEntry(arrayBuffer, 'word/document.xml');
  if (!xml) throw new Error('No encontré el contenido del documento. ¿Es un archivo Word (.docx)?');
  const tables = extractTables(new TextDecoder().decode(xml));
  return parseQualityPlan(tables);
}

/**
 * Convierte el plan leído en lo que se guarda: los datos del proyecto y las
 * operaciones que crean sus participantes, etapas, actividades y catálogos.
 */
export function planToProjectOps(plan) {
  const ops = [];
  for (const p of plan.participantes) {
    ops.push({ op: 'set', table: 'participantes', id: qcNewId(), patch: p });
  }
  for (const e of plan.etapas) {
    const { actividades, ...stageData } = e;
    const stageId = qcNewId();
    ops.push({ op: 'set', table: 'etapas', id: stageId, patch: { ...stageData, fechaRecepcion: null } });
    for (const a of actividades) {
      ops.push({ op: 'set', table: 'actividades', id: qcNewId(), patch: { ...a, etapaId: stageId, estado: 'pendiente', fechaManual: null, fechaTermino: null } });
    }
  }
  ops.push(...catalogOps(plan.catalogos));
  return { projectData: plan.proyecto, ops };
}
