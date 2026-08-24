// KPI del módulo RDI — lo importante acá no es cuántos hay, es CUÁNTO SE
// DEMORA el mandante en responder: eso le da días extra a la constructora
// en la programación, y le sirve al ITO como argumento para presionar a la
// constructora a que no abuse de esos plazos. Todo se calcula desde
// `fechaEnvio`/`fechaRecepcion` — nunca se guarda un "días de respuesta"
// aparte (mismo criterio que Costos: una sola fuente de verdad).

// Mismos rangos que usaba el Excel real de Pancho, para que el informe se
// vea igual de familiar.
const BUCKETS = [
  { label: '0 a 3 días', min: 0, max: 3 },
  { label: '4 a 7 días', min: 4, max: 7 },
  { label: '8 a 14 días', min: 8, max: 14 },
  { label: '15 a 21 días', min: 15, max: 21 },
  { label: '22 a 30 días', min: 22, max: 30 },
  { label: '31 a 60 días', min: 31, max: 60 },
  { label: '61 días o más', min: 61, max: Infinity },
];

// Fecha local (no UTC) para no correr un día por el uso horario de Chile —
// mismo motivo/arreglo que ya se usó en Avance programado.
function parseLocalDate(iso) {
  const [yyyy, mm, dd] = iso.split('-').map(Number);
  return new Date(yyyy, mm - 1, dd);
}

function daysBetween(isoStart, isoEnd) {
  const ms = parseLocalDate(isoEnd) - parseLocalDate(isoStart);
  return Math.max(0, Math.round(ms / 86400000));
}

/** Días que lleva/llevó un RDI: de respuesta si ya la tiene, o los que
 * lleva sin ella (contra hoy) si sigue pendiente. `null` si ni siquiera se
 * envió todavía. */
export function rdiDias(rdi) {
  if (!rdi.fechaEnvio) return null;
  if (rdi.fechaRecepcion) return daysBetween(rdi.fechaEnvio, rdi.fechaRecepcion);
  const hoy = new Date();
  const hoyISO = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
  return daysBetween(rdi.fechaEnvio, hoyISO);
}

export function computeRdiKPI(rdis) {
  const respondidas = rdis.filter((r) => r.fechaRecepcion);
  const pendientes = rdis.filter((r) => !r.fechaRecepcion);
  const diasRespondidas = respondidas.map(rdiDias).filter((d) => d !== null);
  const promedioDias = diasRespondidas.length
    ? Math.round((diasRespondidas.reduce((a, b) => a + b, 0) / diasRespondidas.length) * 10) / 10
    : null;

  return {
    total: rdis.length,
    respondidas: respondidas.length,
    pendientes: pendientes.length,
    promedioDias,
  };
}

/** Tabla de frecuencia de respuesta (mismos rangos que el Excel real):
 * cuántas RDI respondidas y cuántas pendientes caen en cada rango de días. */
export function computeFrecuenciaRespuesta(rdis) {
  return BUCKETS.map((b) => {
    let respondidas = 0;
    let pendientes = 0;
    for (const r of rdis) {
      const dias = rdiDias(r);
      if (dias === null || dias < b.min || dias > b.max) continue;
      if (r.fechaRecepcion) respondidas++;
      else pendientes++;
    }
    return { label: b.label, respondidas, pendientes };
  });
}

/** Las pendientes más atrasadas primero — para presionar al mandante con
 * las que llevan más tiempo sin respuesta. */
export function computeRdiPendientesOrdenadas(rdis) {
  return rdis
    .filter((r) => !r.fechaRecepcion)
    .map((r) => ({ ...r, dias: rdiDias(r) }))
    .sort((a, b) => (b.dias || 0) - (a.dias || 0));
}
