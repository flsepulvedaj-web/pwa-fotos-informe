// Parser de programación exportada desde Microsoft Project — CSV (a mano,
// sin librería, el formato es texto delimitado simple) o Excel (.xlsx/.xls,
// vía SheetJS vendorizado, ver parseScheduleXLSX más abajo). Se hizo lo más
// tolerante posible (delimitador, nombres de columna, formatos de fecha)
// porque se ajustó recién con exports reales de Pancho.

const NAME_ALIASES = ['nombre de tarea', 'nombre de la tarea', 'tarea', 'task name', 'task', 'nombre'];
const START_ALIASES = ['comienzo', 'inicio', 'fecha de inicio', 'start', 'start date'];
const END_ALIASES = ['fin', 'termino', 'término', 'fecha de fin', 'finish', 'finish date'];
const PERCENT_ALIASES = ['% completado', '% completo', '% completada', 'porcentaje completado', '% complete', 'avance', '% avance'];

function detectDelimiter(headerLine) {
  const candidates = [';', ',', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const c of candidates) {
    const count = headerLine.split(c).length;
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  return best;
}

function splitCSVLine(line, delimiter) {
  // Soporta campos entre comillas (pueden contener el delimitador adentro).
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function findColumn(headers, aliases) {
  // Project a veces nombra las columnas del export con "_" en vez de
  // espacio (ej. "Porcentaje_completado") — se normaliza antes de
  // comparar contra los alias, que están escritos con espacios.
  const normalized = headers.map((h) => h.toLowerCase().trim().replace(/_/g, ' '));
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) return idx;
  }
  // Coincidencia parcial como respaldo (ej. "Nombre de tarea 1").
  for (let i = 0; i < normalized.length; i++) {
    if (aliases.some((a) => normalized[i].includes(a))) return i;
  }
  return -1;
}

function parseDate(raw) {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^[a-záéíóú]+\s+/i, ''); // saca "lun " / "mar " al inicio
  // dd-mm-yyyy o dd/mm/yyyy (con año de 2 o 4 dígitos)
  let m = cleaned.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    const date = new Date(Number(y), Number(mo) - 1, Number(d));
    if (!isNaN(date.getTime())) return date;
  }
  // yyyy-mm-dd
  m = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    const date = new Date(Number(y), Number(mo) - 1, Number(d));
    if (!isNaN(date.getTime())) return date;
  }
  const fallback = new Date(cleaned);
  return isNaN(fallback.getTime()) ? null : fallback;
}

function parsePercent(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const num = parseFloat(String(raw).replace('%', '').replace(',', '.').trim());
  if (isNaN(num)) return 0;
  return num <= 1 ? num * 100 : num;
}

function toISO(date) {
  if (!date) return null;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Convierte una hoja a texto CSV a mano, en vez de usar
 * `XLSX.utils.sheet_to_csv` — esa función solo aplica el formato de fecha
 * que se le pida (`dateNF`) cuando la celda NO trae ya un formato propio, y
 * las celdas de fecha de un Excel real casi siempre traen uno (el que haya
 * quedado configurado en Project/Excel, típicamente "m/d/yy" en inglés).
 * Sin este arreglo, una fecha como el 1 de agosto salía "8/1/26" y se
 * terminaba leyendo como 8 de enero. Acá se ignora ese formato: si la celda
 * quedó tipada como fecha (`cellDates: true` al leer), se arma el texto
 * directo con los componentes del Date — sin ambigüedad de dd/mm vs mm/dd
 * posible. OJO: se usan los componentes UTC (`getUTCFullYear`, no
 * `getFullYear`) — SheetJS arma estas fechas como medianoche UTC del día
 * de la planilla (el serial de Excel no tiene huso horario propio); leerlas
 * en local en Chile (UTC-3/-4) las corría un día para atrás, mismo tipo de
 * desfase que ya se arregló en otras partes de Avance con `parseLocalDate`.
 */
function sheetToCsvText(sheet) {
  const ref = sheet['!ref'];
  if (!ref) return '';
  const range = XLSX.utils.decode_range(ref);
  const lines = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cells = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      let text = '';
      if (cell) {
        if (cell.t === 'd' && cell.v instanceof Date) {
          const d = cell.v;
          text = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        } else if (cell.v !== undefined && cell.v !== null) {
          text = String(cell.v);
        }
      }
      if (text.includes(',') || text.includes('"') || text.includes('\n')) {
        text = `"${text.replace(/"/g, '""')}"`;
      }
      cells.push(text);
    }
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

/**
 * Parsea un Excel (.xlsx/.xls) exportado de Project directo, sin que Pancho
 * tenga que exportarlo como CSV primero — usa SheetJS (vendor/xlsx.full.min.js,
 * cargado como <script> global, mismo patrón que jsPDF) solo para leer la
 * primera hoja; de ahí en adelante reusa `parseScheduleCSV` tal cual (vía
 * `sheetToCsvText` arriba), así el reconocimiento de columnas es exactamente
 * el mismo sin importar el formato del archivo.
 */
export function parseScheduleXLSX(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('El Excel no tiene ninguna hoja.');
  }
  const csvText = sheetToCsvText(workbook.Sheets[sheetName]);
  return parseScheduleCSV(csvText);
}

/**
 * Parsea un CSV exportado de Project. Devuelve { tasks, overallPercent } o
 * lanza un Error con un mensaje claro si no logra reconocer las columnas.
 */
export function parseScheduleCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) {
    throw new Error('El archivo está vacío o no tiene filas de tareas.');
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = splitCSVLine(lines[0], delimiter);

  const nameIdx = findColumn(headers, NAME_ALIASES);
  const startIdx = findColumn(headers, START_ALIASES);
  const endIdx = findColumn(headers, END_ALIASES);
  const percentIdx = findColumn(headers, PERCENT_ALIASES);

  if (nameIdx === -1 || percentIdx === -1) {
    throw new Error('No reconocí las columnas de tarea y % completado en el archivo. Revisa que el encabezado tenga "Nombre de tarea" y "% completado" (o algo parecido).');
  }

  const tasks = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i], delimiter);
    const name = cols[nameIdx]?.trim();
    if (!name) continue;
    const plannedStart = startIdx !== -1 ? toISO(parseDate(cols[startIdx])) : null;
    const plannedEnd = endIdx !== -1 ? toISO(parseDate(cols[endIdx])) : null;
    const plannedPercent = parsePercent(cols[percentIdx]);
    tasks.push({ name, plannedStart, plannedEnd, plannedPercent, actualPercent: plannedPercent });
  }

  if (!tasks.length) {
    throw new Error('No encontré ninguna fila de tarea con nombre.');
  }

  // La "tarea resumen del proyecto" (si existe) es la que cubre todo el
  // rango de fechas — se usa su % directo en vez de calcular un promedio.
  const starts = tasks.map((t) => t.plannedStart).filter(Boolean).sort();
  const ends = tasks.map((t) => t.plannedEnd).filter(Boolean).sort();
  const minStart = starts[0];
  const maxEnd = ends[ends.length - 1];

  let summaryTask = null;
  if (minStart && maxEnd) {
    summaryTask = tasks.find((t) => t.plannedStart === minStart && t.plannedEnd === maxEnd && t !== tasks[tasks.length - 1]) || null;
  }
  if (!summaryTask) {
    summaryTask = tasks.find((t) => /resumen del proyecto|resumen de proyecto/i.test(t.name)) || null;
  }

  let overallPercent;
  if (summaryTask) {
    overallPercent = summaryTask.plannedPercent;
  } else {
    // Promedio ponderado por duración (días) de cada tarea — mismo cálculo
    // que usa Project para su propio % completado del proyecto.
    let totalDays = 0;
    let weightedSum = 0;
    for (const t of tasks) {
      let days = 1;
      if (t.plannedStart && t.plannedEnd) {
        const d = (new Date(t.plannedEnd) - new Date(t.plannedStart)) / 86400000;
        days = Math.max(1, d);
      }
      totalDays += days;
      weightedSum += days * t.plannedPercent;
    }
    overallPercent = totalDays > 0 ? weightedSum / totalDays : 0;
  }

  return { tasks, overallPercent: Math.round(overallPercent * 10) / 10 };
}

/**
 * Arma un árbol de partidas a partir de la lista plana de tareas, usando
 * únicamente las fechas (el CSV de Project no trae el nivel de esquema/
 * indentación) — una tarea es "partida principal" cuando su rango de
 * fechas contiene por completo el de las tareas que le siguen, mismo orden
 * en que Project las exporta (padre, después sus hijas, después la
 * siguiente partida). Si el CSV alguna vez trae una columna de nivel de
 * esquema, se puede reemplazar esto por algo más directo — por ahora
 * funciona bien porque Project exporta siempre en orden de esquema.
 *
 * No se marcan "hitos" por duración (fecha inicio = fecha fin): en la
 * práctica, la mayoría de las tareas de 1 día de una programación real son
 * tareas cortas comunes, no hitos de verdad — marcarlas todas en negrita
 * termina destacando casi todo y no sirve de nada. Detectar hitos de
 * verdad necesitaría la columna "Hito"/"Duración" del export de Project.
 */
export function buildTaskTree(tasks) {
  function contains(parent, child) {
    if (!parent.plannedStart || !parent.plannedEnd || !child.plannedStart || !child.plannedEnd) return false;
    if (parent.plannedStart === child.plannedStart && parent.plannedEnd === child.plannedEnd) return false;
    return parent.plannedStart <= child.plannedStart && parent.plannedEnd >= child.plannedEnd;
  }

  const roots = [];
  const stack = []; // [{ task, node }]
  tasks.forEach((task, index) => {
    const node = { task, index, children: [] };
    while (stack.length && !contains(stack[stack.length - 1].task, task)) {
      stack.pop();
    }
    if (stack.length) {
      stack[stack.length - 1].node.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push({ task, node });
  });
  return roots;
}
