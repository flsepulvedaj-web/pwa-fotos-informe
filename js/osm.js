// Geocodificación (Nominatim) y calles/costa del plano (Overpass API) —
// ambos de OpenStreetMap, gratis, sin llave, llamados directo desde el
// navegador (fetch), sin backend propio. Nominatim pide no golpear más de
// 1 req/seg y traer un identificador de la app — por eso `geocodeBatch` las
// hace en fila con una pequeña espera entre cada una, no en paralelo.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const PHOTON_URL = 'https://photon.komoot.io/api/';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Nominatim pide identificar la app en vez de un User-Agent de navegador
// genérico (no se puede fijar el header User-Agent desde fetch, así que se
// manda como parámetro de la propia API).
const APP_EMAIL = 'flsepulvedaj@gmail.com';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function geocodeNominatim(query) {
  const url = `${NOMINATIM_URL}?format=json&limit=1&countrycodes=cl&email=${encodeURIComponent(APP_EMAIL)}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nominatim respondió ${res.status}`);
  const data = await res.json();
  if (!data.length) return null;
  return { lat: Number(data[0].lat), lon: Number(data[0].lon) };
}

/**
 * Photon (Komoot) — mismos datos de OpenStreetMap que Nominatim, así que NO
 * arregla los casos donde a una calle le falta el punto del número exacto
 * (probado: 2 direcciones distintas de "Av. Pacífico" caen en el mismo
 * punto en AMBOS geocodificadores, porque el dato no está en OSM). Sirve
 * como red de respaldo solo para cuando Nominatim no encuentra NADA — ahí
 * a veces Photon sí encuentra algo (aunque sea aproximado, ej. el nombre de
 * la calle o el barrio), mejor que no tener ningún punto. `bias` (lat/lon
 * del sujeto) ayuda a preferir resultados cercanos entre varios homónimos.
 */
async function geocodePhoton(query, bias) {
  const params = new URLSearchParams({ q: query, limit: '1' });
  if (bias) { params.set('lat', bias.lat); params.set('lon', bias.lon); }
  const res = await fetch(`${PHOTON_URL}?${params}`);
  if (!res.ok) throw new Error(`Photon respondió ${res.status}`);
  const data = await res.json();
  const f = data.features?.[0];
  if (!f) return null;
  return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
}

/**
 * Geocodifica una dirección en Chile. Prueba Nominatim primero; si no
 * encuentra nada, prueba Photon como respaldo (ver nota de geocodePhoton).
 * Devuelve {lat, lon, source:'nominatim'|'photon'} o null si ninguno de
 * los dos encontró algo — el llamador decide qué hacer (pedirle a Pancho
 * que la corrija a mano, por ejemplo). Un resultado `source:'photon'` es
 * MENOS confiable (aproximado) — vale la pena revisarlo en el mapa.
 */
export async function geocode(query, bias) {
  const primary = await geocodeNominatim(query);
  if (primary) return { ...primary, source: 'nominatim' };
  try {
    const fallback = await geocodePhoton(query, bias);
    if (fallback) return { ...fallback, source: 'photon' };
  } catch (err) {
    console.error('Photon (respaldo) también falló:', err);
  }
  return null;
}

/**
 * Geocodifica una lista de direcciones, una por una con 1.1s de espera
 * entre cada una (política de uso de Nominatim). `onProgress(i, total)`
 * opcional. Devuelve un array del mismo largo, con {lat,lon,source} o null.
 */
export async function geocodeBatch(queries, onProgress, bias) {
  const out = [];
  for (let i = 0; i < queries.length; i++) {
    try {
      out.push(await geocode(queries[i], bias));
    } catch (err) {
      console.error('No se pudo geocodificar:', queries[i], err);
      out.push(null);
    }
    if (onProgress) onProgress(i + 1, queries.length);
    if (i < queries.length - 1) await sleep(1100);
  }
  return out;
}

/** Distancia en metros entre 2 puntos {lat,lon} (fórmula haversine). */
export function haversine(a, b) {
  const R = 6371000;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/**
 * Trae calles/costa/metro de OpenStreetMap dentro de un radio (metros)
 * alrededor del sujeto. Devuelve el JSON crudo de Overpass (elements con
 * geometry) — `buildBaseSVG` lo proyecta después.
 */
export async function fetchStreetsAround(subject, radiusM) {
  const q = `[out:json][timeout:60];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)$"](around:${radiusM},${subject.lat},${subject.lon});way["natural"="coastline"](around:${radiusM},${subject.lat},${subject.lon});way["railway"="subway"](around:${radiusM},${subject.lat},${subject.lon}););out geom tags;`;
  const res = await fetch(OVERPASS_URL, { method: 'POST', body: 'data=' + encodeURIComponent(q) });
  if (!res.ok) throw new Error(`Overpass respondió ${res.status}`);
  return res.json();
}

const HIGHWAY_CLASS = {
  motorway: 'MAJOR', trunk: 'MAJOR', primary: 'MAJOR',
  secondary: 'MID', tertiary: 'MID',
  residential: 'MINOR', unclassified: 'MINOR', living_street: 'MINOR',
};

/**
 * Proyecta lat/lon a coordenadas SVG locales, centrado en el sujeto:
 * x = (lon-lon0)*mx/U, y = (lat0-lat)*my/U — mismo esquema que ya se usó a
 * mano en la sesión de Cowork, pero centrado y con U (metros por unidad
 * SVG) calculado solo a partir del radio que se quiere mostrar y el tamaño
 * del viewBox, en vez de ajustado a mano por proyecto.
 */
export function makeProjector(subject, radiusM, viewBoxHalfSize) {
  const mx = 111320 * Math.cos((subject.lat * Math.PI) / 180);
  const my = 110900;
  const U = radiusM / viewBoxHalfSize;
  return {
    U,
    project(lat, lon) {
      return {
        x: Math.round(((lon - subject.lon) * mx) / U),
        y: Math.round(((subject.lat - lat) * my) / U),
      };
    },
  };
}

/**
 * Convierte el JSON de Overpass en los mismos 4 strings de <path> que
 * espera el template (COAST, MAJOR, MID, MINOR) — cada uno concatena todas
 * las calles de esa clase en un solo path multi-subtramo ("M..L..M..L..").
 */
export function buildBaseSVG(overpassJson, project) {
  const byClass = { COAST: [], MAJOR: [], MID: [], MINOR: [] };
  for (const el of overpassJson.elements || []) {
    if (el.type !== 'way' || !el.geometry || !el.geometry.length) continue;
    let cls;
    if (el.tags?.natural === 'coastline') cls = 'COAST';
    else if (el.tags?.railway === 'subway') continue; // subte: no se dibuja en el genérico (falta info de estaciones)
    else cls = HIGHWAY_CLASS[el.tags?.highway];
    if (!cls) continue;
    const pts = el.geometry.map((pt) => project(pt.lat, pt.lon));
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join('');
    byClass[cls].push(d);
  }
  const out = {};
  for (const cls of Object.keys(byClass)) {
    if (byClass[cls].length) out[cls] = byClass[cls].join('');
  }
  return out;
}
