// Lee la hoja "CARATULA" de un Estado de Pago (Excel armado a mano por el
// contratista) y saca los números que hoy Pancho escribe a mano en el
// formulario de Costos > Estados de pago: N° de EP, fecha, avance neto del
// período, retención del período y anticipo del período — más un par de
// montos de referencia (monto contratado, total neto EP) para poder avisar
// si algo no cuadra, igual que se hizo con costosPresupuestoParser.js.
//
// La CARATULA es una tabla de "etiqueta → valor" en la misma fila (con
// columnas vacías en el medio por celdas combinadas) — se escanea cada fila
// buscando una celda cuyo texto normalizado calce con una etiqueta conocida,
// y se toma como valor la primera celda no vacía que venga después en esa
// misma fila. Mismo tipo de planilla hecha a mano que costosPresupuestoParser.js,
// mismo enfoque tolerante.

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

  return {
    epNumber: typeof found.epNumber === 'number' ? found.epNumber : '',
    fecha: dateToISO(found.fechaRaw),
    montoContratado: toNumber(found.montoContratado),
    avanceNetoPeriodo: toNumber(found.avanceNetoPeriodo),
    retencionPeriodo: toNumber(found.retencionPeriodo),
    anticipoPeriodo: toNumber(found.anticipoPeriodo),
    totalNetoEP: toNumber(found.totalNetoEP),
    totalEP: toNumber(found.totalEP),
    sheetUsed: sheetName,
  };
}
