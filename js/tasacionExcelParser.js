// Parser del Excel de tasación bancaria (formato fijo del banco, verificado
// contra 2 informes reales: AO260157 Puerto Serena II y AO260388 Puerta
// Florida). Lee 3 pestañas:
//
// - "Informe Tasación": datos del sujeto (dirección, comuna, región, AO,
//   fecha de visita, UF vigente esa fecha) — celdas fijas.
// - "DEPTO": una fila por unidad desde la fila 18 (C=n°, E=tipo, K=interior,
//   L=terraza, M=total homologado ya calculado por la propia planilla,
//   N=UF/m² tasado, Q=COMERCIAL total UF, W=PRECIO LISTA INMOB. total UF) —
//   se agrupa por tipo para sacar el promedio de cada tipología.
// - "REF TIPOLOGIA": bloques repetidos por tipología ("TIPOLOGÍA n:" en
//   columna A, tipo en G), cada uno con su propia lista de referencias
//   (dirección, calidad, m² construcción, UF/m² construcción, valor total,
//   link) — es la muestra de mercado que el propio tasador ya armó a mano.
//   El tamaño del bloque no se asume fijo: se lee hasta la fila "PROMEDIO"
//   o la siguiente "TIPOLOGÍA", lo que venga primero.

function cell(ws, addr) {
  const c = ws[addr];
  return c ? c.v : undefined;
}

function str(v) {
  return String(v ?? '').trim();
}

function num(v) {
  return typeof v === 'number' ? v : null;
}

/** "2026-03-10" tal cual, o si viniera como Date (cellDates), a 'YYYY-MM-DD'. */
function toDateStr(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return str(v);
}

function parseInformeTasacion(ws) {
  if (!ws) return {};
  return {
    ao: str(cell(ws, 'AC2')),
    nombreProyecto: str(cell(ws, 'G9')),
    direccion: str(cell(ws, 'E12')),
    comuna: str(cell(ws, 'E13')),
    region: str(cell(ws, 'E14')),
    fechaVisita: toDateStr(cell(ws, 'AC3')),
    ufTasacionFecha: num(cell(ws, 'AC4')),
  };
}

/**
 * DEPTO: filas desde la 18, C tiene el n° de depto (criterio de fila
 * válida: C numérico y E con el tipo). Devuelve las unidades crudas +
 * el resumen agrupado por tipo.
 */
function parseDepto(ws) {
  if (!ws) return { unidades: [], tipologias: [] };
  const range = XLSX.utils.decode_range(ws['!ref']);
  const unidades = [];
  for (let r = 17; r <= range.e.r; r++) {
    const n = cell(ws, 'C' + (r + 1));
    const tipo = str(cell(ws, 'E' + (r + 1))).toUpperCase();
    if (typeof n !== 'number' || !tipo) continue;
    unidades.push({
      n,
      tipo,
      orientacion: str(cell(ws, 'F' + (r + 1))),
      interior: num(cell(ws, 'K' + (r + 1))),
      terraza: num(cell(ws, 'L' + (r + 1))) || 0,
      supHomologada: num(cell(ws, 'M' + (r + 1))),
      tasadoUFm2: num(cell(ws, 'N' + (r + 1))),
      comercialUF: num(cell(ws, 'Q' + (r + 1))),
      listaUF: num(cell(ws, 'W' + (r + 1))),
    });
  }

  const porTipo = new Map();
  for (const u of unidades) {
    if (!porTipo.has(u.tipo)) porTipo.set(u.tipo, []);
    porTipo.get(u.tipo).push(u);
  }
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const tipologias = [...porTipo.entries()].map(([tipo, us]) => {
    const listaUFm2 = us.map((u) => (u.listaUF != null && u.supHomologada ? u.listaUF / u.supHomologada : null)).filter((v) => v != null);
    return {
      tipo,
      unidades: us.length,
      supHomologadaProm: round2(avg(us.map((u) => u.supHomologada).filter((v) => v != null))),
      tasadoUFm2Prom: round2(avg(us.map((u) => u.tasadoUFm2).filter((v) => v != null))),
      listaUFm2Prom: round2(avg(listaUFm2)),
    };
  });

  return { unidades, tipologias };
}

function round2(v) {
  return v == null ? null : Math.round(v * 100) / 100;
}

/**
 * REF TIPOLOGIA: bloques "TIPOLOGÍA n:" (col A) con el tipo en col G de esa
 * misma fila. Debajo, encabezado 2 filas más abajo y datos desde 3 filas
 * más abajo, hasta la fila "PROMEDIO" (col K) o la siguiente "TIPOLOGÍA".
 */
function parseRefTipologia(ws) {
  if (!ws) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const muestras = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const a = str(cell(ws, 'A' + (r + 1)));
    if (!/^TIPOLOGÍA\s*\d+:?$/i.test(a)) continue;
    const tipo = str(cell(ws, 'G' + (r + 1))).toUpperCase();
    if (!tipo) continue;
    const dataStart = r + 3; // +1 header "REFERENCIAS DE MERCADO", +1 header de columnas, +1 primer dato
    for (let dr = dataStart; dr <= range.e.r; dr++) {
      const kVal = str(cell(ws, 'K' + (dr + 1)));
      const aVal = str(cell(ws, 'A' + (dr + 1)));
      if (kVal.toUpperCase().startsWith('PROMEDIO')) break; // fin del bloque
      if (/^TIPOLOGÍA\s*\d+:?$/i.test(aVal)) break; // el siguiente bloque, sin fila "PROMEDIO" (no debería pasar, por si acaso)
      const direccion = str(cell(ws, 'B' + (dr + 1)));
      if (!direccion) continue; // fila reservada sin usar
      muestras.push({
        tipo,
        direccion,
        link: str(cell(ws, 'K' + (dr + 1))),
        calidad: str(cell(ws, 'N' + (dr + 1))),
        m2Const: num(cell(ws, 'T' + (dr + 1))),
        ufm2: num(cell(ws, 'Z' + (dr + 1))),
        valorTotal: num(cell(ws, 'AC' + (dr + 1))),
      });
    }
  }
  return muestras;
}

/**
 * Parsea el Excel completo. `arrayBuffer`: contenido del archivo (desde un
 * <input type="file"> o descargado de Drive). Lanza error si falta alguna
 * hoja clave.
 */
export function parseTasacionXLSX(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
  const informeWs = workbook.Sheets['Informe Tasación'];
  const deptoWs = workbook.Sheets['DEPTO'];
  const refWs = workbook.Sheets['REF TIPOLOGIA'];

  if (!informeWs || !deptoWs) {
    throw new Error('No encontré las hojas "Informe Tasación" y/o "DEPTO" — ¿es el Excel de tasación del banco?');
  }

  const informe = parseInformeTasacion(informeWs);
  const { unidades, tipologias } = parseDepto(deptoWs);
  if (!unidades.length) {
    throw new Error('No encontré unidades en la hoja DEPTO (filas desde la 18, con N° y TIPO).');
  }
  const refs = parseRefTipologia(refWs);

  return { ...informe, unidades, tipologias, refs };
}
