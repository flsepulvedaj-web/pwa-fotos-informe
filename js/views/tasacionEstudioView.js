import { getTasacionEstudio, updateTasacionEstudio } from '../db.js';
import { geocode, geocodeBatch, haversine, fetchStreetsAround, makeProjector, buildBaseSVG } from '../osm.js';
import { fetchUFHoy } from '../tasacionUF.js';
import { buildTasacionHTML } from '../tasacionRender.js';
import { uploadTasacionBackup } from '../tasacionSync.js';
import { isSignedIn } from '../googleDrive.js';
import { navigate } from '../router.js';
import { toast, escapeHTML } from '../utils.js';

const ESTADO_LABEL = { aprobada: '✅ Aprobada', pendiente: '⏳ Pendiente', descartada: '🚫 Descartada' };

function fmtN(v, d = 1) {
  return v == null ? '—' : Number(v).toLocaleString('es-CL', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Recalcula la distancia (m) de cada muestra geocodificada al sujeto —
 * se llama cada vez que el sujeto o una muestra cambia de coordenadas. */
function recomputeDistances(estudio) {
  if (estudio.subjectLat == null || estudio.subjectLon == null) return;
  const subject = { lat: estudio.subjectLat, lon: estudio.subjectLon };
  for (const m of estudio.muestras) {
    if (m.lat != null && m.lon != null) {
      m.dist = haversine(subject, { lat: m.lat, lon: m.lon });
    }
  }
}

export async function renderTasacionEstudioView(container, id) {
  let estudio = await getTasacionEstudio(id);
  if (!estudio) {
    container.innerHTML = `<div class="empty-state"><p>Este estudio ya no existe.</p></div>`;
    return;
  }
  let generatedHTML = null;
  let generating = false;

  async function save(changes) {
    estudio = await updateTasacionEstudio(estudio.id, changes);
  }

  function muestrasByTipo(tipo) {
    return estudio.muestras.filter((m) => m.tipo === tipo);
  }

  function paint() {
    const hasSubject = estudio.subjectLat != null && estudio.subjectLon != null;
    const pendingGeocode = estudio.muestras.filter((m) => m.lat == null).length;

    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">${escapeHTML(estudio.nombreProyecto || estudio.ao || 'Estudio')}</span>
      </header>
      <main class="view-content tasacion-view">
        <section class="tasacion-card">
          <h3>Datos del informe</h3>
          <p><b>${escapeHTML(estudio.ao)}</b> — ${escapeHTML(estudio.nombreProyecto)}</p>
          <p>${escapeHTML(estudio.direccion)}, ${escapeHTML(estudio.comuna)}, ${escapeHTML(estudio.region)}</p>
          <p>Fecha de visita: ${escapeHTML(estudio.fechaVisita || '—')} · UF esa fecha: ${fmtN(estudio.ufTasacionFecha, 2)}</p>
        </section>

        <section class="tasacion-card">
          <h3>Ubicación del sujeto</h3>
          <div class="tasacion-row">
            <label>Lat <input type="number" step="0.000001" id="in-lat" value="${estudio.subjectLat ?? ''}" /></label>
            <label>Lon <input type="number" step="0.000001" id="in-lon" value="${estudio.subjectLon ?? ''}" /></label>
            <button class="btn btn-secondary" id="btn-geocode-subject">📍 Buscar automático</button>
            ${hasSubject ? `<a class="btn btn-secondary" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${estudio.subjectLat},${estudio.subjectLon}">Ver en Maps</a>` : ''}
          </div>
          ${!hasSubject ? '<p class="tasacion-warn">⚠️ La geocodificación automática de direcciones exactas en Chile no siempre es precisa — revisa el pin en Maps y corrige lat/lon a mano si hace falta.</p>' : ''}
          ${hasSubject && estudio.subjectGeocodeSource === 'photon' ? '<p class="tasacion-warn">⚠️ Ubicación aproximada (respaldo Photon, Nominatim no encontró nada) — revísala bien en Maps.</p>' : ''}
        </section>

        <section class="tasacion-card">
          <h3>UF de hoy</h3>
          <div class="tasacion-row">
            <label>Valor <input type="number" step="0.01" id="in-uf-hoy" value="${estudio.ufHoy ?? ''}" /></label>
            <span class="tasacion-muted">${estudio.ufHoyFecha ? 'al ' + estudio.ufHoyFecha : ''}</span>
            <button class="btn btn-secondary" id="btn-refresh-uf">🔄 Actualizar</button>
          </div>
        </section>

        <section class="tasacion-card">
          <h3>Muestras de mercado</h3>
          ${pendingGeocode ? `<button class="btn btn-secondary" id="btn-geocode-pending">📍 Geocodificar ${pendingGeocode} pendiente(s)</button>` : ''}
          ${estudio.tipologias.map((t) => `
            <h4>${escapeHTML(t.tipo)} — tasado ${fmtN(t.tasadoUFm2Prom)} UF/m² · lista ${fmtN(t.listaUFm2Prom)} UF/m² · ${t.unidades} unid.</h4>
            <div class="tablebox-wrap">
              <table class="tasacion-table">
                <thead><tr><th>Dirección</th><th>Calidad</th><th class="num">m²</th><th class="num">UF/m²</th><th class="num">Dist.</th><th>Estado</th><th></th></tr></thead>
                <tbody>
                  ${muestrasByTipo(t.tipo).map((m) => `
                    <tr data-muestra-id="${m.id}">
                      <td>${escapeHTML(m.direccion)}</td>
                      <td>${escapeHTML(m.calidad || '—')}</td>
                      <td class="num">${fmtN(m.m2Const)}</td>
                      <td class="num">${fmtN(m.ufm2)}</td>
                      <td class="num">${m.dist != null ? fmtN(m.dist, 0) + ' m' : '—'}${m.geocodeSource === 'photon' ? ' <span title="Ubicación aproximada (respaldo Photon) — revisa el pin">⚠️</span>' : ''}</td>
                      <td>
                        <select class="in-estado" data-muestra-id="${m.id}">
                          ${['aprobada', 'pendiente', 'descartada'].map((s) => `<option value="${s}" ${m.estado === s ? 'selected' : ''}>${ESTADO_LABEL[s]}</option>`).join('')}
                        </select>
                      </td>
                      <td>${m.link ? `<a href="${escapeHTML(m.link)}" target="_blank" rel="noopener">🔗</a>` : ''}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `).join('')}
        </section>

        <section class="tasacion-card">
          <h3>Informe final</h3>
          <div class="tasacion-row">
            <button class="btn btn-secondary" id="btn-generate" ${!hasSubject ? 'disabled title="Primero fija la ubicación del sujeto"' : ''}>${generating ? '⏳ Generando…' : '🗺️ Generar informe'}</button>
            ${generatedHTML ? `<button class="btn btn-secondary" id="btn-download">⬇️ Descargar HTML</button>` : ''}
            ${generatedHTML ? `<button class="btn btn-secondary" id="btn-upload-drive">☁️ Subir respaldo a Drive</button>` : ''}
          </div>
          ${generatedHTML ? `<iframe id="preview-frame" class="tasacion-preview" srcdoc="${escapeHTML(generatedHTML)}"></iframe>` : '<p class="tasacion-muted">Todavía no se ha generado el informe.</p>'}
        </section>
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate('/banco/estudio-mercado'));

    container.querySelector('#in-lat').addEventListener('change', async (e) => {
      const lat = parseFloat(e.target.value);
      await save({ subjectLat: Number.isFinite(lat) ? lat : null });
      recomputeDistances(estudio);
      await save({ muestras: estudio.muestras });
      paint();
    });
    container.querySelector('#in-lon').addEventListener('change', async (e) => {
      const lon = parseFloat(e.target.value);
      await save({ subjectLon: Number.isFinite(lon) ? lon : null });
      recomputeDistances(estudio);
      await save({ muestras: estudio.muestras });
      paint();
    });

    container.querySelector('#btn-geocode-subject').addEventListener('click', async () => {
      toast('Buscando ubicación…');
      try {
        const pos = await geocode(`${estudio.direccion}, ${estudio.comuna}, Chile`);
        if (!pos) { toast('⚠️ No encontré esa dirección — ingresa lat/lon a mano.'); return; }
        await save({ subjectLat: pos.lat, subjectLon: pos.lon, subjectGeocodeSource: pos.source });
        recomputeDistances(estudio);
        await save({ muestras: estudio.muestras });
        toast(pos.source === 'photon'
          ? '⚠️ Ubicación aproximada (respaldo Photon) — revísala bien en Maps.'
          : 'Ubicación encontrada — revísala en Maps antes de generar el informe.');
        paint();
      } catch (err) {
        console.error(err);
        toast('⚠️ No se pudo geocodificar (revisa tu conexión).');
      }
    });

    container.querySelector('#btn-refresh-uf').addEventListener('click', async () => {
      toast('Buscando UF de hoy…');
      const r = await fetchUFHoy();
      if (!r) { toast('⚠️ No se pudo obtener la UF — ingrésala a mano.'); return; }
      await save({ ufHoy: r.valor, ufHoyFecha: r.fecha });
      toast(`UF ${fmtN(r.valor, 2)} (${r.fecha})`);
      paint();
    });
    container.querySelector('#in-uf-hoy').addEventListener('change', async (e) => {
      const v = parseFloat(e.target.value);
      await save({ ufHoy: Number.isFinite(v) ? v : null });
    });

    const btnGeocodePending = container.querySelector('#btn-geocode-pending');
    if (btnGeocodePending) {
      btnGeocodePending.addEventListener('click', async () => {
        if (estudio.subjectLat == null) { toast('⚠️ Primero fija la ubicación del sujeto.'); return; }
        const pending = estudio.muestras.filter((m) => m.lat == null);
        toast(`Geocodificando ${pending.length} dirección(es), 1 por segundo…`);
        // La comuna se agrega siempre (aunque la dirección ya la mencione) —
        // sin ella, Nominatim muchas veces devuelve un resultado en OTRA
        // comuna/región con nombre de calle parecido (probado con datos
        // reales: sin comuna, una dirección de La Serena resolvió a 349 km).
        const bias = { lat: estudio.subjectLat, lon: estudio.subjectLon };
        const results = await geocodeBatch(pending.map((m) => `${m.direccion}, ${estudio.comuna}, Chile`), (i, total) => {
          if (i % 3 === 0 || i === total) toast(`Geocodificando… ${i}/${total}`);
        }, bias);
        results.forEach((pos, i) => {
          if (pos) { pending[i].lat = pos.lat; pending[i].lon = pos.lon; pending[i].geocodeSource = pos.source; }
        });
        recomputeDistances(estudio);
        await save({ muestras: estudio.muestras });
        const found = results.filter(Boolean).length;
        const aproximadas = results.filter((r) => r?.source === 'photon').length;
        toast(`Listo: ${found}/${pending.length} encontradas${aproximadas ? ` (${aproximadas} aproximadas, marcadas con ⚠️)` : ''}. Revisa el plano antes de confiar 100% en la ubicación.`);
        paint();
      });
    }

    container.querySelectorAll('.in-estado').forEach((sel) => {
      sel.addEventListener('change', async (e) => {
        const m = estudio.muestras.find((x) => x.id === e.target.dataset.muestraId);
        if (m) m.estado = e.target.value;
        await save({ muestras: estudio.muestras });
      });
    });

    container.querySelector('#btn-generate').addEventListener('click', async () => {
      generating = true;
      paint();
      try {
        let base = {};
        try {
          const overpass = await fetchStreetsAround({ lat: estudio.subjectLat, lon: estudio.subjectLon }, 2500);
          const proj = makeProjector({ lat: estudio.subjectLat, lon: estudio.subjectLon }, 2500, 450);
          base = buildBaseSVG(overpass, proj.project);
        } catch (err) {
          console.error('No se pudo traer el plano base de OpenStreetMap:', err);
          toast('⚠️ No se pudieron traer las calles (sigue sin ellas) — revisa tu conexión.');
        }
        generatedHTML = await buildTasacionHTML(estudio, base);
        toast('Informe generado.');
      } catch (err) {
        console.error('Error generando el informe:', err);
        toast(`⚠️ ${err.message || 'No se pudo generar el informe.'}`);
      }
      generating = false;
      paint();
    });

    const btnDownload = container.querySelector('#btn-download');
    if (btnDownload) {
      btnDownload.addEventListener('click', () => {
        const blob = new Blob([generatedHTML], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Estudio de mercado - ${estudio.nombreProyecto || estudio.ao}.html`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      });
    }

    const btnUploadDrive = container.querySelector('#btn-upload-drive');
    if (btnUploadDrive) {
      btnUploadDrive.addEventListener('click', async () => {
        if (!isSignedIn()) { toast('⚠️ Inicia sesión con Google primero.'); return; }
        toast('Subiendo a Drive…');
        const r = await uploadTasacionBackup(estudio, generatedHTML);
        toast(r.ok ? '☁️ Respaldo subido a Drive.' : '⚠️ No se pudo subir el respaldo.');
        if (r.ok) await save({ driveFolderId: r.folderId });
      });
    }
  }

  paint();

  // Best-effort, en segundo plano: UF de hoy si nunca se buscó.
  if (estudio.ufHoy == null) {
    fetchUFHoy().then(async (r) => {
      if (r) {
        await save({ ufHoy: r.valor, ufHoyFecha: r.fecha });
        paint();
      }
    }).catch(() => {});
  }
}
