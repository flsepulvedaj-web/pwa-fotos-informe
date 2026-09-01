// Lee un Estado de Pago (Excel armado a mano por el contratista): la hoja
// "CARATULA" para los totales generales (N° de EP, fecha, avance neto del
// período, retención, anticipo) — igual que antes — y AHORA TAMBIÉN la hoja
// "DETALLE" para el desglose de partidas del período (cuánto se le pagó a
// cada partida en ESTE EP, no el presupuesto original completo). Mismo
// enfoque tolerante que costosPresupuestoParser.js en los dos casos.
//
// La CARATULA es una tabla de "etiqueta → valor" en la misma fila (con
// columnas vacías en el medio por celdas combinadas) — se escanea cada fila
// buscando una celda cuyo texto normalizado calce con una etiqueta conocida,
// y se toma como valor la primera celda no vacía que venga después en esa
// misma fila.
//
// La DETALLE tiene 4 bloques de columnas repetidos (PRESUPUESTO, EP
// ACUMULADO, EP ANTERIOR, EP ACTUAL), cada uno con su "% AVANCE" y su
// "Total" — acá solo interesa el bloque "EP ACTUAL" (columnas 11 y 12,
// verificado a mano contra un archivo real): es lo que se cobró en ESTE
// período por esa partida. Misma regla de "es una partida real" que
// costosPresupuestoParser.js: Total del período numérico Y (Unidad o
// Cantidad) con algo cargado.

const LABELS = {
  'estado de pago n': 'epNumber',
  fecha: 'fechaRaw',
  'monto contratado': 'montoContratado',
  'presente estado de pago': 'avanceNetoPeriodo',
  'retenciones ep actual': 'retencionPeriodo',
  'anticipo ep actual': 'anticipoPeriodo',
  'total neto ep': 'totalNetoEP',
  'total ep': 'totalEP',
};

function normalizeLabel(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[°:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(v) {
  // Redondeado a pesos enteros: los montos del Excel arrastran decimales de
  // cálculos internos (ej. 28457200.303278133) que no aportan nada acá —
  // mismo criterio que costosPresupuestoParser.js. Celdas tipo "$-" u otras
  // no numéricas se tratan como 0.
  if (typeof v === 'number') return Math.round(v);
  return 0;
}

/** Fecha con getUTC* (no getFullYear/getDate) — SheetJS arma las fechas de
 * Excel como medianoche UTC del día de la planilla; leerlas en hora de
 * Chile las corre un día para atrás. Mismo arreglo que sheetToCsvText en
 * controlScheduleParser.js. */
function dateToISO(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const CATEGORIA_RE = /^[A-Z]\d{0,2}$/i;

function cellStr(v) {
  return String(v ?? '').trim();
}

/** % con el mismo criterio tolerante que parsePercent en
 * controlScheduleParser.js: una celda de Excel con formato "%" trae el
 * valor ya como fracción (0.25), no como "25" — pero por si acaso viene
 * como número entero (25) o como texto ("25%"), se cubren los 3 casos. */
function toPercent(v) {
  if (typeof v === 'number') return v <= 1 ? Math.round(v * 1000) / 10 : Math.round(v * 10) / 10;
  if (typeof v === 'string' && v.trim()) {
    const num = parseFloat(v.replace('%', '').replace(',', '.'));
    if (!isNaN(num)) return num <= 1 ? Math.round(num * 1000) / 10 : Math.round(num * 10) / 10;
  }
  return 0;
}

/** Desglose de partidas del período (hoja DETALLE) — solo el bloque
 * "EP ACTUAL" (columnas 11 y 12: % avance y total pagado en ESTE período),
 * no el presupuesto completo (eso lo lee costosPresupuestoParser.js). */
function parseDetalleItems(workbook) {
  const sheetName = workbook.SheetNames.find((n) => n.toUpperCase().includes('DETALLE'));
  if (!sheetName) return { items: [], sheetUsed: null };
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

  let currentCategoria = '';
  const items = [];
  for (const row of rows) {
    const c0 = cellStr(row[0]);
    const c1 = cellStr(row[1]);
    const c2 = cellStr(row[2]); // Descripción
    const c3 = cellStr(row[3]); // Unidad
    const c4 = row[4]; // Cantidad
    const c11 = row[11]; // % avance EP ACTUAL
    const c12 = row[12]; // Total EP ACTUAL (este período)

    if (CATEGORIA_RE.test(c0)) currentCategoria = c0.toUpperCase();

    const totalActual = typeof c12 === 'number' ? c12 : null;
    const cantidadNum = typeof c4 === 'number' ? c4 : null;
    const isItem = totalActual !== null && (c3 !== '' || cantidadNum !== null) && c2 !== '';
    if (!isItem) continue;

    items.push({
      categoria: currentCategoria,
      item: c1 || '',
      descripcion: c2,
      unidad: c3,
      avanceActualPercent: toPercent(c11),
      totalActual,
    });
  }
  return { items, sheetUsed: sheetName };
}

export function parseEstadoPagoXLSX(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
  const sheetName =
    workbook.SheetNames.find((n) => n.toUpperCase().includes('CARATULA')) ||
    workbook.SheetNames.find((n) => n.toUpperCase().includes('RESUMEN')) ||
    workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('El Excel no tiene ninguna hoja.');
  }
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

  const found = {};
  for (const row of rows) {
    for (let j = 0; j < row.length; j++) {
      const key = LABELS[normalizeLabel(row[j])];
      if (!key || key in found) continue;
      let value;
      for (let k = j + 1; k < row.length; k++) {
        if (row[k] !== '' && row[k] !== null && row[k] !== undefined) {
          value = row[k];
          break;
        }
      }
      if (value !== undefined) found[key] = value;
    }
  }

  if (found.epNumber === undefined && found.avanceNetoPeriodo === undefined) {
    throw new Error('No reconocí los datos del estado de pago en el archivo. Revisá que sea la hoja "CARATULA" del Excel del contratista.');
  }

  const { items, sheetUsed: detalleSheetUsed } = parseDetalleItems(workbook);

  return {
    epNumber: typeof found.epNumber === 'number' ? found.epNumber : '',
    fecha: dateToISO(found.fechaRaw),
    montoContratado: toNumber(found.montoContratado),
    avanceNetoPeriodo: toNumber(found.avanceNetoPeriodo),
    retencionPeriodo: toNumber(found.retencionPeriodo),
    anticipoPeriodo: toNumber(found.anticipoPeriodo),
    totalNetoEP: toNumber(found.totalNetoEP),
    totalEP: toNumber(found.totalEP),
    items,
    sheetUsed: sheetName,
    detalleSheetUsed,
  };
}
