// Parser del desglose de presupuesto original por partidas, a partir de la
// hoja "DETALLE" (o similar) de un estado de pago exportado de Excel por un
// contratista — mismo tipo de planilla irregular hecha a mano (columnas que
// se corren de fila en fila, encabezados de categoría repetidos, filas de
// subtotal). Regla verificada a mano contra un archivo real de 372 filas
// (Vizor Reports, obra File 589 Loncoche, EP N°1):
//
// Una fila es una PARTIDA PRESUPUESTADA real si tiene un Total (columna G,
// "Total" de la sección PRESUPUESTO — la primera de las 4 columnas "Total"
// que trae el archivo, antes de las de EP Acumulado/Anterior/Actual) que sea
// un número, Y ADEMÁS tiene Unidad (columna D) o Cantidad (columna E) con
// algún valor. Esa combinación excluye automáticamente:
//   - encabezados de categoría/sub-grupo (sin unidad, cantidad ni total)
//   - filas "TOTAL COSTO DIRECTO ..." / subtotales (sin unidad ni cantidad)
//   - filas de precio de referencia sin cantidad real (sin total)
// y a la vez SÍ incluye partidas sueltas al final (Gastos Generales,
// Utilidad, Costo Financiero) que no siempre traen unidad cargada pero sí
// cantidad o total. Verificado: la suma de partidas capturadas cuadra con
// el Monto Contratado de la carátula, categoría por categoría.
//
// La categoría (columna A, ej. "A", "B", "F2") se recuerda fila a fila
// (persiste hasta que aparece una nueva) porque algunas filas de item no la
// repiten.

const CATEGORIA_RE = /^[A-Z]\d{0,2}$/i;

function cellStr(v) {
  return String(v ?? '').trim();
}

/**
 * Parsea un Excel (.xlsx/.xls) y devuelve { items, grandTotal, sheetUsed }.
 * `items`: [{ categoria, item, descripcion, unidad, cantidad, precioUnitario, total }]
 */
export function parsePresupuestoDetalleXLSX(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName =
    workbook.SheetNames.find((n) => n.toUpperCase().includes('DETALLE')) ||
    workbook.SheetNames.find((n) => n.toUpperCase().includes('PRESUPUESTO')) ||
    workbook.SheetNames[workbook.SheetNames.length - 1];
  if (!sheetName) {
    throw new Error('El Excel no tiene ninguna hoja.');
  }
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
    const c5 = row[5]; // Precio unitario
    const c6 = row[6]; // Total (columna "Total" de PRESUPUESTO)

    if (CATEGORIA_RE.test(c0)) currentCategoria = c0.toUpperCase();

    const total = typeof c6 === 'number' ? c6 : null;
    const cantidadNum = typeof c4 === 'number' ? c4 : null;
    const isItem = total !== null && (c3 !== '' || cantidadNum !== null) && c2 !== '';
    if (!isItem) continue;

    items.push({
      categoria: currentCategoria,
      item: c1 || '',
      descripcion: c2,
      unidad: c3,
      cantidad: cantidadNum ?? '',
      precioUnitario: typeof c5 === 'number' ? c5 : '',
      total,
    });
  }

  if (!items.length) {
    throw new Error('No encontré partidas con cantidad/total en el archivo. Revisá que sea la hoja "DETALLE" del estado de pago, con las columnas Unidad, Cantidad, P.Unit. y Total.');
  }

  const grandTotal = items.reduce((sum, it) => sum + it.total, 0);
  return { items, grandTotal: Math.round(grandTotal), sheetUsed: sheetName };
}
