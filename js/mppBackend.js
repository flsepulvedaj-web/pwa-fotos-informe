// Lee un .mpp (Microsoft Project) nativo, sin que Pancho tenga que
// exportarlo a CSV/Excel primero — no existe forma de leer ese formato en
// el navegador (ver vizor-reports-mpp-backend/README.md), así que se manda
// al servidor propio (Java + MPXJ, Google Cloud Run) que devuelve texto
// CSV con las mismas 4 columnas que ya entiende `parseScheduleCSV` — el
// servidor solo traduce el binario a texto, toda la lógica de negocio
// (tarea resumen, % general, árbol de tareas) sigue viviendo acá.
import { parseScheduleCSV } from './controlScheduleParser.js';

// TODO: completar con la URL real una vez que Pancho despliegue
// vizor-reports-mpp-backend en Google Cloud Run (ver su README.md) — mismo
// patrón que AI_BACKEND_URL en aiAvance.js.
const MPP_BACKEND_URL = '';

export function isMppBackendConfigured() {
  return !!MPP_BACKEND_URL;
}

/**
 * Manda el .mpp al servidor y devuelve { tasks, overallPercent } — mismo
 * shape que parseScheduleCSV/parseScheduleXLSX, así el resto de la app
 * (Avance programado, Curva S, árbol de tareas) no necesita saber de dónde
 * vino el dato.
 */
export async function parseMPPViaBackend(file, token) {
  if (!MPP_BACKEND_URL) {
    throw new Error('La lectura de .mpp todavía no está conectada — subí el archivo como CSV o Excel mientras tanto.');
  }
  if (!navigator.onLine) {
    const err = new Error('Necesitás internet para leer un .mpp.');
    err.offline = true;
    throw err;
  }

  const res = await fetch(MPP_BACKEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let reason = text;
    try {
      reason = JSON.parse(text).error || text;
    } catch {
      // no era JSON, se usa el texto tal cual
    }
    throw new Error(reason || `Error leyendo el .mpp (${res.status})`);
  }

  const csvText = await res.text();
  return parseScheduleCSV(csvText);
}
