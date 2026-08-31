import {
  getObra,
  updateObra,
  getInformeSemanal,
  updateInformeSemanal,
  getScheduleSnapshotsByObra,
  getSSMAEntriesByObra,
  getChecklistEntriesByObra,
  getChecklistTypesByObra,
  getChecklistPhotosInRange,
  getCostosContrato,
  getCostosModificacionesByObra,
  getCostosFacturasByObra,
  getRdiSolicitudesByObra,
} from '../db.js';
import {
  computeAvanceKPI,
  computePersonalKPI,
  computeChecklistKPI,
} from '../controlDashboard.js';
import {
  computePresupuestoVigente,
  computeTotalFacturado,
  computeAvanceFinancieroPercent,
  formatMonto,
} from '../costosDashboard.js';
import { computeRdiKPI } from '../rdiDashboard.js';
import { getSignedInEmail, openFolderPicker, uploadFile } from '../googleDrive.js';
import { modulesForEmail, getCachedPermissions, isAdmin } from '../permissions.js';
import { openSignaturePad } from '../signaturePad.js';
import { buildInformeSemanalPDF } from '../informeSemanalPdfExport.js';
import { uploadObrasIndex } from '../obraSync.js';
import { sanitizeFilename } from '../pdfExport.js';
import { navigate } from '../router.js';
import { uuid, escapeHTML, toast } from '../utils.js';

function formatDateEs(iso) {
  if (!iso) return '—';
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Resta N días a una fecha 'YYYY-MM-DD', en horario local (no UTC) — mismo
 * cuidado que ya se tuvo en Avance/RDI con el desfase de huso horario. */
function daysBeforeISO(iso, n) {
  const [yyyy, mm, dd] = iso.split('-').map(Number);
  const d = new Date(yyyy, mm - 1, dd);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let objectURLs = [];
function trackURL(url) {
  objectURLs.push(url);
  return url;
}
function revokeAllURLs() {
  objectURLs.forEach((u) => URL.revokeObjectURL(u));
  objectURLs = [];
}

/**
 * El documento completo del Informe Semanal: datos de la reunión,
 * participantes (2 tablas) con firma, temas conversados, el compilado de
 * KPI de los demás módulos (solo lectura, se recalcula siempre) y el botón
 * de emitir a PDF. Las tablas de filas (participantes/temas) se editan
 * manipulando el DOM directo, no con un re-render completo — así no se
 * pierde lo que ya se escribió en otras filas a medio llenar. El DOM es la
 * fuente de verdad mientras se edita: "Guardar" lee los valores actuales de
 * los inputs, no un arreglo en memoria aparte.
 */
export async function renderInformeSemanalFormView(container, informeId) {
  revokeAllURLs();

  let informe = await getInformeSemanal(informeId);
  if (!informe) {
    navigate('/control');
    return;
  }
  const obra = await getObra(informe.obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  const email = await getSignedInEmail();
  const allowedModules = modulesForEmail(email, getCachedPermissions());
  const canSeeCostos = allowedModules.includes('costos');
  const admin = isAdmin(email);

  // Firmas capturadas en esta sesión de edición, por fila (rowId de sesión
  // → Blob). Se precarga con lo que ya estaba guardado en el informe.
  const firmasPorFila = new Map();

  function rowTemplate(kind, data = {}) {
    const rowId = uuid();
    if (kind === 'participante') {
      if (data.firmaBlob) firmasPorFila.set(rowId, data.firmaBlob);
      return `
        <div class="acta-row" data-row-id="${rowId}">
          <input type="text" class="acta-input-nombre" placeholder="Nombre" value="${escapeHTML(data.nombre || '')}" />
          <input type="text" class="acta-input-cargo" placeholder="Cargo" value="${escapeHTML(data.cargo || '')}" />
          <input type="text" class="acta-input-iniciales" placeholder="Iniciales" value="${escapeHTML(data.iniciales || '')}" />
          <button type="button" class="btn btn-secondary acta-firmar-btn" data-row-id="${rowId}">${data.firmaBlob ? '✅ Firmado' : '✍️ Firmar'}</button>
          <button type="button" class="icon-btn acta-row-delete" data-row-id="${rowId}" title="Quitar">🗑️</button>
        </div>
      `;
    }
    return `
      <div class="acta-row acta-tema-row" data-row-id="${rowId}">
        <span class="acta-tema-num"></span>
        <input type="text" class="acta-input-punto" placeholder="Punto conversado" value="${escapeHTML(data.punto || '')}" />
        <input type="text" class="acta-input-responsable" placeholder="Responsable" value="${escapeHTML(data.responsable || '')}" />
        <button type="button" class="icon-btn acta-row-delete" data-row-id="${rowId}" title="Quitar">🗑️</button>
      </div>
    `;
  }

  function renumberTemas(listEl) {
    [...listEl.querySelectorAll('.acta-tema-row')].forEach((row, i) => {
      row.querySelector('.acta-tema-num').textContent = `${i + 1}.`;
    });
  }

  function readParticipantesRows(listEl) {
    return [...listEl.querySelectorAll('.acta-row')].map((row) => ({
      nombre: row.querySelector('.acta-input-nombre').value.trim(),
      cargo: row.querySelector('.acta-input-cargo').value.trim(),
      iniciales: row.querySelector('.acta-input-iniciales').value.trim(),
      firmaBlob: firmasPorFila.get(row.dataset.rowId) || null,
    })).filter((p) => p.nombre); // filas vacías no se guardan
  }

  function readTemasRows(listEl) {
    return [...listEl.querySelectorAll('.acta-tema-row')].map((row) => ({
      punto: row.querySelector('.acta-input-punto').value.trim(),
      responsable: row.querySelector('.acta-input-responsable').value.trim(),
    })).filter((t) => t.punto);
  }

  async function loadCompilado() {
    const [snapshots, ssmaEntries, checklistEntries, checklistTypes] = await Promise.all([
      getScheduleSnapshotsByObra(obra.id),
      getSSMAEntriesByObra(obra.id),
      getChecklistEntriesByObra(obra.id),
      getChecklistTypesByObra(obra.id),
    ]);
    const avance = computeAvanceKPI(snapshots);
    const personal = computePersonalKPI(ssmaEntries);
    const checklist = computeChecklistKPI(checklistEntries, checklistTypes);

    let costos = null;
    if (canSeeCostos) {
      const [contrato, modificaciones, facturas] = await Promise.all([
        getCostosContrato(obra.id),
        getCostosModificacionesByObra(obra.id),
        getCostosFacturasByObra(obra.id),
      ]);
      if (contrato || modificaciones.length || facturas.length) {
        const presupuestoVigente = computePresupuestoVigente(contrato, modificaciones);
        const totalFacturado = computeTotalFacturado(facturas);
        costos = {
          moneda: contrato?.moneda || '$',
          presupuestoVigente,
          totalFacturado,
          avancePercent: computeAvanceFinancieroPercent(totalFacturado, presupuestoVigente),
        };
      }
    }

    const rdis = await getRdiSolicitudesByObra(obra.id);
    const rdi = rdis.length ? computeRdiKPI(rdis) : null;

    const fromDate = daysBeforeISO(informe.fecha || todayLocalISO(), 7);
    const toDate = informe.fecha || todayLocalISO();
    const fotos = await getChecklistPhotosInRange(obra.id, fromDate, toDate);

    return { avance, personal, checklist, costos, rdi, fotos };
  }

  function paint(compilado) {
    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Informe Semanal — ${escapeHTML(obra.name)}</span>
      </header>
      <main class="view-content">

        <form class="ssma-form" id="datos-form">
          <h2>Datos de la reunión</h2>
          <label for="d-fecha">Fecha</label>
          <input type="date" id="d-fecha" value="${informe.fecha || todayLocalISO()}" />
          <label for="d-lugar">Lugar</label>
          <input type="text" id="d-lugar" placeholder="Ej: Presencial" value="${escapeHTML(informe.lugar || '')}" />
          <label for="d-hora">Hora de inicio</label>
          <input type="time" id="d-hora" value="${escapeHTML(informe.horaInicio || '')}" />
          <label for="d-titulo">Título de la reunión</label>
          <input type="text" id="d-titulo" placeholder="Ej: Reunión Proyecto File 589" value="${escapeHTML(informe.reunionTitulo || '')}" />
          <div class="ssma-form-actions">
            <button type="submit" class="btn btn-primary">Guardar</button>
          </div>
        </form>

        <section class="ssma-form">
          <h2>Participantes — Por constructora</h2>
          <div class="acta-row-list" id="list-constructora">
            ${informe.participantesConstructora.length
              ? informe.participantesConstructora.map((p) => rowTemplate('participante', p)).join('')
              : rowTemplate('participante')}
          </div>
          <div class="ssma-form-actions">
            <button type="button" class="btn btn-secondary" id="btn-add-constructora">+ Agregar participante</button>
            <button type="button" class="btn btn-primary" id="btn-save-constructora">Guardar</button>
          </div>
        </section>

        <section class="ssma-form">
          <h2>Participantes — Por LEN / ENEX</h2>
          <div class="acta-row-list" id="list-len">
            ${informe.participantesLen.length
              ? informe.participantesLen.map((p) => rowTemplate('participante', p)).join('')
              : rowTemplate('participante')}
          </div>
          <div class="ssma-form-actions">
            <button type="button" class="btn btn-secondary" id="btn-add-len">+ Agregar participante</button>
            <button type="button" class="btn btn-primary" id="btn-save-len">Guardar</button>
          </div>
        </section>

        <section class="ssma-form">
          <h2>Temas conversados</h2>
          <div class="acta-row-list" id="list-temas">
            ${informe.temas.length ? informe.temas.map((t) => rowTemplate('tema', t)).join('') : rowTemplate('tema')}
          </div>
          <div class="ssma-form-actions">
            <button type="button" class="btn btn-secondary" id="btn-add-tema">+ Agregar tema</button>
            <button type="button" class="btn btn-primary" id="btn-save-temas">Guardar</button>
          </div>
        </section>

        <section class="ssma-form">
          <h2>Compilado (últimos datos cargados)</h2>
          <div class="kpi-tiles">
            <div class="kpi-tile">
              <div class="kpi-value">${compilado.avance.latestPercent !== null ? compilado.avance.latestPercent + '%' : '—'}</div>
              <div class="kpi-label">Avance programado</div>
            </div>
            <div class="kpi-tile">
              <div class="kpi-value">${compilado.personal.todayTotal !== null ? compilado.personal.todayTotal : '—'}</div>
              <div class="kpi-label">Personal hoy</div>
            </div>
            <div class="kpi-tile">
              <div class="kpi-value">${compilado.checklist.cumplimientoPercent !== null ? compilado.checklist.cumplimientoPercent + '%' : '—'}</div>
              <div class="kpi-label">Cumplimiento checklist (30d)</div>
            </div>
            ${compilado.costos ? `
              <div class="kpi-tile">
                <div class="kpi-value">${formatMonto(compilado.costos.presupuestoVigente, compilado.costos.moneda)}</div>
                <div class="kpi-label">Presupuesto vigente</div>
              </div>
              <div class="kpi-tile">
                <div class="kpi-value">${compilado.costos.avancePercent !== null ? compilado.costos.avancePercent + '%' : '—'}</div>
                <div class="kpi-label">Avance financiero</div>
              </div>
            ` : ''}
            ${compilado.rdi ? `
              <div class="kpi-tile">
                <div class="kpi-value">${compilado.rdi.promedioDias !== null ? compilado.rdi.promedioDias + 'd' : '—'}</div>
                <div class="kpi-label">RDI — días de respuesta</div>
              </div>
              <div class="kpi-tile">
                <div class="kpi-value">${compilado.rdi.pendientes}</div>
                <div class="kpi-label">RDI sin responder</div>
              </div>
            ` : ''}
          </div>
          ${compilado.fotos.length ? `
            <h3 class="acta-fotos-title">Fotos de la semana (${compilado.fotos.length})</h3>
            <div class="protocol-photo-grid">
              ${compilado.fotos.map((p) => `<div class="protocol-photo-item"><img src="${trackURL(URL.createObjectURL(p.blob))}" alt="Foto" /></div>`).join('')}
            </div>
          ` : '<p class="acta-fotos-empty">Sin fotos cargadas en el Checklist diario los últimos 7 días.</p>'}
        </section>

        <section class="ssma-form">
          <h2>Emitir informe</h2>
          <p class="informe-status">Estado: <strong>${informe.status === 'emitted' ? 'Emitido ✅' : 'Borrador'}</strong>${informe.pdfDriveFileName ? ` — ${escapeHTML(informe.pdfDriveFileName)}` : ''}</p>
          <div class="ssma-form-actions">
            <button type="button" class="btn btn-primary" id="btn-emitir">${informe.status === 'emitted' ? 'Volver a emitir' : '📤 Emitir informe (PDF)'}</button>
          </div>
        </section>
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate(`/informe-semanal/obra/${obra.id}`));

    container.querySelector('#datos-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      // OJO: no se hace un re-render completo acá — recargaría
      // Participantes/Temas desde la BD y borraría cualquier fila que el
      // usuario haya escrito pero todavía no guardado en esas secciones.
      informe = await updateInformeSemanal(informe.id, {
        fecha: container.querySelector('#d-fecha').value,
        lugar: container.querySelector('#d-lugar').value.trim(),
        horaInicio: container.querySelector('#d-hora').value,
        reunionTitulo: container.querySelector('#d-titulo').value.trim(),
      });
      toast('Datos de la reunión guardados. Si cambiaste la fecha, volvé a entrar para actualizar el compilado.');
    });

    function wireRowList(listEl, kind, addBtn) {
      addBtn.addEventListener('click', () => {
        listEl.insertAdjacentHTML('beforeend', rowTemplate(kind));
        if (kind === 'tema') renumberTemas(listEl);
      });
      listEl.addEventListener('click', (e) => {
        const del = e.target.closest('.acta-row-delete');
        if (del) {
          firmasPorFila.delete(del.dataset.rowId);
          del.closest('.acta-row').remove();
          if (kind === 'tema') renumberTemas(listEl);
          return;
        }
        const firmar = e.target.closest('.acta-firmar-btn');
        if (firmar) {
          const row = firmar.closest('.acta-row');
          const nombre = row.querySelector('.acta-input-nombre').value.trim();
          if (!nombre) {
            toast('Escribe el nombre antes de firmar.');
            return;
          }
          openSignaturePad({ title: `Firma — ${nombre}` }).then((blob) => {
            if (!blob) return;
            firmasPorFila.set(firmar.dataset.rowId, blob);
            firmar.textContent = '✅ Firmado';
          });
        }
      });
      if (kind === 'tema') renumberTemas(listEl);
    }

    const listConstructora = container.querySelector('#list-constructora');
    const listLen = container.querySelector('#list-len');
    const listTemas = container.querySelector('#list-temas');
    wireRowList(listConstructora, 'participante', container.querySelector('#btn-add-constructora'));
    wireRowList(listLen, 'participante', container.querySelector('#btn-add-len'));
    wireRowList(listTemas, 'tema', container.querySelector('#btn-add-tema'));

    container.querySelector('#btn-save-constructora').addEventListener('click', async () => {
      informe = await updateInformeSemanal(informe.id, { participantesConstructora: readParticipantesRows(listConstructora) });
      toast('Participantes guardados.');
    });
    container.querySelector('#btn-save-len').addEventListener('click', async () => {
      informe = await updateInformeSemanal(informe.id, { participantesLen: readParticipantesRows(listLen) });
      toast('Participantes guardados.');
    });
    container.querySelector('#btn-save-temas').addEventListener('click', async () => {
      informe = await updateInformeSemanal(informe.id, { temas: readTemasRows(listTemas) });
      toast('Temas guardados.');
    });

    container.querySelector('#btn-emitir').addEventListener('click', async () => {
      const btn = container.querySelector('#btn-emitir');
      if (btn.disabled) return;
      btn.disabled = true;

      try {
        // Guarda todo lo que esté en pantalla antes de emitir, por si a
        // Pancho se le olvidó tocar "Guardar" en alguna sección.
        informe = await updateInformeSemanal(informe.id, {
          fecha: container.querySelector('#d-fecha').value,
          lugar: container.querySelector('#d-lugar').value.trim(),
          horaInicio: container.querySelector('#d-hora').value,
          reunionTitulo: container.querySelector('#d-titulo').value.trim(),
          participantesConstructora: readParticipantesRows(listConstructora),
          participantesLen: readParticipantesRows(listLen),
          temas: readTemasRows(listTemas),
        });

        let folderId = obra.informeDriveFolderId;
        if (!folderId && !admin) {
          toast('Esta obra todavía no tiene carpeta de Drive para el Informe Semanal — pedile al admin que la vincule primero.');
          btn.disabled = false;
          btn.textContent = informe.status === 'emitted' ? 'Volver a emitir' : '📤 Emitir informe (PDF)';
          return;
        }
        if (!folderId) {
          toast('Elige en qué carpeta quieres guardar los informes semanales de esta obra…');
          let picked;
          try {
            picked = await openFolderPicker();
          } catch (err) {
            console.error(err);
            toast('No se pudo conectar con Google Drive.');
            btn.disabled = false;
            return;
          }
          if (!picked) {
            btn.disabled = false;
            return;
          }
          folderId = picked.id;
          await updateObra(obra.id, { informeDriveFolderId: picked.id, informeDriveFolderName: picked.name });
          obra.informeDriveFolderId = picked.id;
          obra.informeDriveFolderName = picked.name;
          uploadObrasIndex(); // best-effort — le llega al resto del equipo sin esperar a que abran Control
        }

        btn.textContent = 'Generando PDF…';
        const pdfBlob = await buildInformeSemanalPDF(
          { obraName: obra.name, informe, compilado },
          (p, total) => { btn.textContent = `Generando PDF (${p}/${total})…`; }
        );

        btn.textContent = 'Subiendo a Drive…';
        const filename = `Informe-Semanal-${sanitizeFilename(obra.name)}-${informe.fecha}.pdf`;
        const uploaded = await uploadFile(folderId, pdfBlob, filename);

        informe = await updateInformeSemanal(informe.id, {
          status: 'emitted',
          pdfDriveFileId: uploaded.id,
          pdfDriveFileName: filename,
        });
        toast(`Informe emitido y guardado en "${obra.informeDriveFolderName}".`);
        renderInformeSemanalFormView(container, informeId);
      } catch (err) {
        console.error(err);
        toast('No se pudo generar/subir el informe. Intenta de nuevo.');
        btn.disabled = false;
        btn.textContent = informe.status === 'emitted' ? 'Volver a emitir' : '📤 Emitir informe (PDF)';
      }
    });
  }

  paint(await loadCompilado());
}
