// Fechas del módulo Control de calidad: días hábiles con los feriados de
// Chile y lectura de los plazos escritos en texto ("Hasta 10 días hábiles",
// "Día 0 a 1", "En paralelo"…). Todas las fechas se manejan como texto
// "AAAA-MM-DD" (sin hora) para no tener problemas de zona horaria.

// Feriados nacionales. Fuentes: calendarios 2026 y 2027 publicados por la
// prensa chilena (24horas.cl, Talana), contrastados entre sí. El 17-sep-2027
// (feriado adicional de Fiestas Patrias) aparece en una fuente y otra lo da
// como día hábil: por eso queda marcado `porConfirmar`. El módulo permite
// editar esta lista por proyecto (tabla Catálogos), así que no está fijo.
export const CHILE_HOLIDAYS = [
  ['2026-01-01', 'Año Nuevo'],
  ['2026-04-03', 'Viernes Santo'],
  ['2026-04-04', 'Sábado Santo'],
  ['2026-05-01', 'Día del Trabajo'],
  ['2026-05-21', 'Glorias Navales'],
  ['2026-06-21', 'Día de los Pueblos Indígenas'],
  ['2026-06-29', 'San Pedro y San Pablo'],
  ['2026-07-16', 'Virgen del Carmen'],
  ['2026-08-15', 'Asunción de la Virgen'],
  ['2026-09-18', 'Independencia Nacional'],
  ['2026-09-19', 'Glorias del Ejército'],
  ['2026-10-12', 'Encuentro de Dos Mundos'],
  ['2026-10-31', 'Iglesias Evangélicas y Protestantes'],
  ['2026-11-01', 'Todos los Santos'],
  ['2026-12-08', 'Inmaculada Concepción'],
  ['2026-12-25', 'Navidad'],
  ['2027-01-01', 'Año Nuevo'],
  ['2027-03-26', 'Viernes Santo'],
  ['2027-03-27', 'Sábado Santo'],
  ['2027-05-01', 'Día del Trabajo'],
  ['2027-05-21', 'Glorias Navales'],
  ['2027-06-21', 'Día de los Pueblos Indígenas'],
  ['2027-06-28', 'San Pedro y San Pablo'],
  ['2027-07-16', 'Virgen del Carmen'],
  ['2027-08-15', 'Asunción de la Virgen'],
  ['2027-09-17', 'Feriado adicional Fiestas Patrias (por confirmar)', true],
  ['2027-09-18', 'Independencia Nacional'],
  ['2027-09-19', 'Glorias del Ejército'],
  ['2027-10-11', 'Encuentro de Dos Mundos'],
  ['2027-10-31', 'Iglesias Evangélicas y Protestantes'],
  ['2027-11-01', 'Todos los Santos'],
  ['2027-12-08', 'Inmaculada Concepción'],
  ['2027-12-25', 'Navidad'],
].map(([fecha, nombre, porConfirmar]) => ({ fecha, nombre, porConfirmar: !!porConfirmar }));

export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toISO(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addCalendarDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** `holidays`: arreglo de textos "AAAA-MM-DD" (o de { fecha }). */
function holidaySet(holidays) {
  if (holidays instanceof Set) return holidays;
  return new Set((holidays || CHILE_HOLIDAYS).map((h) => (typeof h === 'string' ? h : h.fecha)));
}

/** Día hábil = lunes a viernes que no sea feriado. */
export function isBusinessDay(iso, holidays) {
  const dow = parseISO(iso).getDay();
  if (dow === 0 || dow === 6) return false;
  return !holidaySet(holidays).has(iso);
}

/**
 * Suma `n` días hábiles. El "día 0" es la propia fecha base (aunque no sea
 * hábil); el día 1 es el primer día hábil después, y así. Con n negativo
 * cuenta hacia atrás.
 */
export function addBusinessDays(iso, n, holidays) {
  const set = holidaySet(holidays);
  const step = n < 0 ? -1 : 1;
  let remaining = Math.abs(n);
  let current = iso;
  while (remaining > 0) {
    current = addCalendarDays(current, step);
    if (isBusinessDay(current, set)) remaining--;
  }
  return current;
}

/** Días hábiles entre dos fechas (sin contar la de partida, contando la de llegada). */
export function businessDaysBetween(fromISO, toISO_, holidays) {
  if (fromISO === toISO_) return 0;
  const set = holidaySet(holidays);
  const forward = fromISO < toISO_;
  let count = 0;
  let current = fromISO;
  while (current !== toISO_) {
    current = addCalendarDays(current, forward ? 1 : -1);
    if (isBusinessDay(current, set)) count++;
  }
  return forward ? count : -count;
}

/**
 * Interpreta el texto de plazo de una actividad de control. Devuelve:
 *  - { tipo: 'recepcion', desde, hasta }  "Día 0 a 1", "Hasta 10 días hábiles":
 *      días hábiles contados desde la recepción de la entrega.
 *  - { tipo: 'paralelo' }                 "En paralelo": mismo plazo que la revisión de la etapa.
 *  - { tipo: 'inicio', diasCorridos }     "Primeros 30 días", "Primera semana": desde el inicio del servicio.
 *  - { tipo: 'evento', evento, dias }     "Hasta 5 días hábiles desde la re-entrega": depende de otra fecha.
 *  - { tipo: 'tabla41' }                  "Según Tabla 4.1".
 *  - { tipo: 'texto' }                    cualquier otro ("Antes del ingreso"): se pone a mano.
 */
export function parsePlazo(texto) {
  const t = String(texto || '').trim();
  const norm = t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  if (/^en paralelo/.test(norm)) return { tipo: 'paralelo' };

  let m = norm.match(/^dia\s*(\d+)(?:\s*a\s*(\d+))?$/);
  if (m) return { tipo: 'recepcion', desde: Number(m[1]), hasta: Number(m[2] ?? m[1]) };

  m = norm.match(/^hasta\s+(\d+)\s+dias\s+habiles\s+desde\s+(?:el\s+)?(informe|la\s+re-?entrega)/);
  if (m) return { tipo: 'evento', evento: /informe/.test(m[2]) ? 'informe' : 'reentrega', dias: Number(m[1]) };

  m = norm.match(/^hasta\s+(\d+)\s+dias\s+habiles$/);
  if (m) return { tipo: 'recepcion', desde: 0, hasta: Number(m[1]) };

  if (/^segun tabla\s*4\.?1/.test(norm)) return { tipo: 'tabla41' };

  m = norm.match(/^primeros\s+(\d+)\s+dias/);
  if (m) return { tipo: 'inicio', diasCorridos: Number(m[1]) };
  if (/^primera semana/.test(norm)) return { tipo: 'inicio', diasCorridos: 7 };

  return { tipo: 'texto' };
}

/**
 * Ventana de fechas de una actividad según su plazo y las fechas ya
 * conocidas. `etapa.fechaRecepcion` es la fecha de recepción de la entrega
 * (prevista mientras no llega, real cuando llega); `proyecto.fechaInicio` es
 * el inicio del servicio. Una fecha puesta a mano (`actividad.fechaManual`)
 * manda por sobre el cálculo.
 * Devuelve { desde, hasta, origen: 'manual' | 'calculada' } o null si todavía
 * no hay con qué calcular.
 */
export function ventanaActividad(actividad, etapa, proyecto, holidays) {
  if (actividad.fechaManual) return { desde: null, hasta: actividad.fechaManual, origen: 'manual' };
  const plazo = actividad.plazoParseado || parsePlazo(actividad.plazoTexto);
  const recepcion = etapa?.fechaRecepcion;

  if (plazo.tipo === 'recepcion' && recepcion) {
    return {
      desde: addBusinessDays(recepcion, plazo.desde, holidays),
      hasta: addBusinessDays(recepcion, plazo.hasta, holidays),
      origen: 'calculada',
    };
  }
  if (plazo.tipo === 'paralelo' && recepcion) {
    return { desde: recepcion, hasta: addBusinessDays(recepcion, etapa.plazoRevisionDias || 10, holidays), origen: 'calculada' };
  }
  if (plazo.tipo === 'inicio' && proyecto?.fechaInicio) {
    return { desde: proyecto.fechaInicio, hasta: addCalendarDays(proyecto.fechaInicio, plazo.diasCorridos), origen: 'calculada' };
  }
  return null;
}

/** "2026-11-12" -> "jue 12-nov-2026" */
export function formatFecha(iso) {
  if (!iso) return '';
  const d = parseISO(iso);
  const dias = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${dias[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}-${meses[d.getMonth()]}-${d.getFullYear()}`;
}
