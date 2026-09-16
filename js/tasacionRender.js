// Arma la página final (resumen, tabs, plano, gráfico, tabla) a partir de
// un `estudio` guardado — mismo motor visual de la sesión de Cowork
// (templates/tasacion-template.html, HTML/SVG puro sin librerías), pero
// con el CFG/BASE calculados en vez de escritos a mano por proyecto.
import { computeMarketStats, buildDefenseText } from './tasacionMarket.js';

const VIEWBOX_HALF = 450; // medio lado del viewBox cuadrado (900x900), sujeto siempre al centro
const RINGS_M = [500, 1000, 2000];
const RADIUS_M = 2500; // hasta dónde se ve una muestra en el plano

let templateCache = null;
async function loadTemplate() {
  if (templateCache) return templateCache;
  const res = await fetch('./templates/tasacion-template.html');
  if (!res.ok) throw new Error('No se pudo cargar la plantilla del plano.');
  templateCache = await res.text();
  return templateCache;
}

function fmtDateEs(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}-${m}-${y}` : iso;
}

/**
 * Arma la lista de `samples` en el formato que espera la plantilla, a
 * partir de las muestras aprobadas del estudio (solo esas: pendientes y
 * descartadas no se dibujan ni entran en ningún cálculo).
 */
function buildSamplesForTemplate(estudio, project) {
  return estudio.muestras
    .filter((m) => m.estado === 'aprobada' && m.lat != null && m.lon != null)
    .map((m, i) => {
      const { x, y } = project(m.lat, m.lon);
      return {
        uid: m.id || `s${i}`,
        // La plantilla usa `id` como TEXTO del link de la fila (no como
        // identificador — ese es `uid`) — sin esto salía literalmente
        // "undefined" en la tabla de muestras.
        id: 'Ver referencia',
        kind: m.kind || 'ref',
        tipo: m.tipo,
        name: m.direccion,
        dev: m.calidad ? `Calidad: ${m.calidad}` : '',
        util: m.m2Const,
        terr: 0,
        sup: m.m2Const,
        uf_pub: Math.round(m.valorTotal || 0),
        uf: Math.round(m.valorTotal || 0),
        ufm2: m.ufm2,
        dist: m.dist,
        x,
        y,
        entrega: '',
        age: '',
        nota: '',
        url: m.link || '',
        fuente: m.origen === 'ref-tipologia' ? 'Referencia de tu informe' : (m.fuente || ''),
      };
    });
}

/**
 * `estudio`: registro completo de db.js (tasacionEstudios). `base`: el
 * resultado de buildBaseSVG (osm.js) o {} si todavía no se trajo/falló.
 * Devuelve el HTML final (string), listo para mostrar en un iframe o
 * descargar como archivo.
 */
export async function buildTasacionHTML(estudio, base = {}) {
  const tpl = await loadTemplate();
  const subject = { lat: estudio.subjectLat, lon: estudio.subjectLon };
  const U = RADIUS_M / VIEWBOX_HALF;
  const mx = 111320 * Math.cos(((subject.lat || 0) * Math.PI) / 180);
  const my = 110900;
  const project = (lat, lon) => ({
    x: Math.round(((lon - subject.lon) * mx) / U),
    y: Math.round(((subject.lat - lat) * my) / U),
  });

  const samples = buildSamplesForTemplate(estudio, project);

  const tipos = estudio.tipologias.map((t) => {
    const market = computeMarketStats(estudio.muestras, t.tipo);
    const defense = buildDefenseText(t.tipo, t.tasadoUFm2Prom, t.listaUFm2Prom, market);
    const withDist = samples.filter((s) => s.tipo === t.tipo).map((s) => s.dist).filter((d) => d != null);
    return {
      key: t.tipo,
      label: t.tipo,
      tasado: t.tasadoUFm2Prom,
      tmin: market ? market.min : t.tasadoUFm2Prom,
      tmax: market ? market.max : t.tasadoUFm2Prom,
      lista: t.listaUFm2Prom,
      units: t.unidades,
      sup: t.supHomologadaProm,
      level: defense.level,
      levelLabel: defense.levelLabel,
      title: defense.title,
      points: defense.points,
      market: market || { n: 0, med: t.tasadoUFm2Prom, p25: t.tasadoUFm2Prom, p75: t.tasadoUFm2Prom, rule: 'Sin muestra aprobada', uids: [] },
      reading: market
        ? `Mediana ${market.med} UF/m², n ${market.n}`
        : 'Sin muestra aprobada todavía',
      _hasDist: withDist.length > 0,
    };
  });

  const nDeptos = estudio.tipologias.reduce((a, t) => a + t.unidades, 0);
  const breakdown = estudio.tipologias.map((t) => `${t.unidades} ${t.tipo.toLowerCase()}`).join(' · ');
  const meta = `${estudio.direccion}, ${estudio.comuna}<br>${nDeptos} deptos: ${breakdown}<br>UF/m² sobre útil + 50% terraza, como tu planilla DEPTO`;
  const eyebrow = `Defensa de tasación · ${estudio.ao} · ${estudio.nombreProyecto} · ${fmtDateEs(new Date().toISOString().slice(0, 10))}`;
  const h1 = `${estudio.nombreProyecto} por tipología`;

  const notes = [
    '<b>Muestra de mercado</b> = referencias de tu informe (y las que hayas agregado y aprobado) a ≤1 km del sujeto — se amplía a ≤2 km si hay menos de 5. Tasación = columna COMERCIAL y lista = PRECIO LISTA INMOB. de tu pestaña DEPTO.',
    '<b>Precios de oferta</b>, no de cierre. Las coordenadas de las referencias salen de geocodificar su dirección (OpenStreetMap/Nominatim) — pueden ser aproximadas si la dirección no tenía un punto exacto; revísalas si algo se ve raro en el plano.',
    `Generado automáticamente el ${fmtDateEs(new Date().toISOString().slice(0, 10))}. UF de hoy: ${estudio.ufHoy ?? '—'}${estudio.ufHoyFecha ? ' (' + fmtDateEs(estudio.ufHoyFecha) + ')' : ''}.`,
  ];

  const cfg = {
    viewBox: `${-VIEWBOX_HALF} ${-VIEWBOX_HALF} ${VIEWBOX_HALF * 2} ${VIEWBOX_HALF * 2}`,
    U,
    subject: [0, 0],
    subjectName: estudio.nombreProyecto,
    subjLabel: [0, -20, 'middle'],
    subjFont: 18,
    subjR: 12,
    rings: RINGS_M,
    ringFont: 12,
    radius: RADIUS_M,
    markR: 7,
    lblFont: 11,
    north: [VIEWBOX_HALF - 40, -VIEWBOX_HALF + 40],
    scaleAt: [-VIEWBOX_HALF + 30, VIEWBOX_HALF - 30],
    labels: [],
    labelOff: {},
    tipos,
    samples,
  };

  const html = tpl
    .replace('__TITLE__', h1)
    .replace('__EYEBROW__', eyebrow)
    .replace('__H1__', h1)
    .replace('__META__', meta)
    .replace('__VIEWBOX__', cfg.viewBox)
    .replace('__SUBJECT__', estudio.nombreProyecto)
    .replace('__RINGS__', RINGS_M.map((m) => (m >= 1000 ? (m / 1000) + ' km' : m + ' m')).join(' · '))
    .replace('__NOTES__', notes.map((n) => `<li>${n}</li>`).join(''))
    .replace('__CONFIG__', JSON.stringify(cfg))
    .replace('__BASE__', JSON.stringify(base));

  return html;
}
