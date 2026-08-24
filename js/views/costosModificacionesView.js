import {
  getObra,
  costosMontoTotal,
  getCostosModificacionesByObra,
  addCostosModificacion,
  updateCostosModificacion,
  deleteCostosModificacion,
} from '../db.js';
import { isSignedIn } from '../googleDrive.js';
import { uploadModificacion, syncModificacionesFromDrive } from '../costosSync.js';
import { navigate } from '../router.js';
import { escapeHTML, confirmDialog, toast } from '../utils.js';
import { formatMonto } from '../costosDashboard.js';

const TIPO_LABEL = { modificacion: 'Modificación', proforma: 'Proforma' };
const SUBTIPO_LABEL = { aumento: 'Aumento', disminucion: 'Disminución', obraExtraordinaria: 'Obra extraordinaria' };
const ESTADO_LABEL = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada' };

function formatDateEs(iso) {
  if (!iso) return '—';
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function montoGroupHTML(prefix, label, values = {}) {
  return `
    <fieldset class="costos-monto-group">
      <legend>${label}</legend>
      <label for="${prefix}-cd">Costo directo</label>
      <input type="number" id="${prefix}-cd" min="0" step="1" inputmode="decimal" value="${values.costoDirecto ?? ''}" />
      <label for="${prefix}-gg">Gastos generales</label>
      <input type="number" id="${prefix}-gg" min="0" step="1" inputmode="decimal" value="${values.gastosGenerales ?? ''}" />
      <label for="${prefix}-ut">Utilidad</label>
      <input type="number" id="${prefix}-ut" min="0" step="1" inputmode="decimal" value="${values.utilidad ?? ''}" />
    </fieldset>
  `;
}

function readMontoGroup(container, prefix) {
  const num = (id) => Math.max(0, parseFloat(container.querySelector(id)?.value) || 0);
  return {
    costoDirecto: num(`#${prefix}-cd`),
    gastosGenerales: num(`#${prefix}-gg`),
    utilidad: num(`#${prefix}-ut`),
  };
}

/**
 * Modificaciones de obra (MO) y proformas: formulario para agregar/editar +
 * historial debajo — mismo patrón que Personal en obra (controlSSMAView.js).
 * "Monto aprobado" solo tiene sentido si ya está aprobada, "monto estimado"
 * mientras está pendiente — se muestran u ocultan según el estado elegido.
 */
export async function renderCostosModificacionesView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/costos');
    return;
  }

  let items = await getCostosModificacionesByObra(obraId);
  let editingId = null;

  async function syncFromDrive({ auto }) {
    if (!obra.costosDriveFolderId) return;
    if (auto && !isSignedIn()) return;
    try {
      const changed = await syncModificacionesFromDrive(obraId, obra.costosDriveFolderId);
      items = await getCostosModificacionesByObra(obraId);
      if (changed) {
        toast(`📥 ${changed} modificación(es) traída(s) de Drive.`);
        paint();
      } else if (!auto) {
        toast('Ya tenés todo lo más reciente.');
      }
    } catch (err) {
      console.error('Error sincronizando modificaciones desde Drive:', err);
      if (!auto) toast('No se pudo conectar con Drive.');
    }
  }

  function paint() {
    const editing = editingId ? items.find((m) => m.id === editingId) : null;
    const estado = editing?.estado || 'pendiente';
    const tipo = editing?.tipo || 'modificacion';

    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Modificaciones — ${escapeHTML(obra.name)}</span>
      </header>
      <main class="view-content">
        <form class="ssma-form" id="mo-form">
          <h2>${editingId ? 'Editar modificación' : 'Nueva modificación'}</h2>

          <label for="mo-numero">N°</label>
          <input type="text" id="mo-numero" placeholder="Ej: 1" value="${escapeHTML(editing?.numero || '')}" />

          <label for="mo-descripcion">Descripción</label>
          <input type="text" id="mo-descripcion" placeholder="Ej: Aumento excavación sector norte" value="${escapeHTML(editing?.descripcion || '')}" />

          <label for="mo-fecha">Fecha de presentación</label>
          <input type="date" id="mo-fecha" value="${editing?.fechaPresentacion || todayLocalISO()}" />

          <label for="mo-tipo">Tipo</label>
          <select id="mo-tipo">
            <option value="modificacion" ${tipo === 'modificacion' ? 'selected' : ''}>Modificación</option>
            <option value="proforma" ${tipo === 'proforma' ? 'selected' : ''}>Proforma</option>
          </select>

          <label for="mo-subtipo">Clasificación</label>
          <select id="mo-subtipo">
            <option value="aumento" ${editing?.subtipo === 'aumento' ? 'selected' : ''}>Aumento</option>
            <option value="disminucion" ${editing?.subtipo === 'disminucion' ? 'selected' : ''}>Disminución</option>
            <option value="obraExtraordinaria" ${editing?.subtipo === 'obraExtraordinaria' ? 'selected' : ''}>Obra extraordinaria</option>
          </select>

          ${montoGroupHTML('mo-pres', 'Monto presentado', editing?.montoPresentado)}

          <label for="mo-estado">Estado</label>
          <select id="mo-estado">
            <option value="pendiente" ${estado === 'pendiente' ? 'selected' : ''}>Pendiente</option>
            <option value="aprobada" ${estado === 'aprobada' ? 'selected' : ''}>Aprobada</option>
            <option value="rechazada" ${estado === 'rechazada' ? 'selected' : ''}>Rechazada</option>
          </select>

          <div id="mo-aprobado-wrap" ${estado === 'aprobada' ? '' : 'hidden'}>
            ${montoGroupHTML('mo-aprob', 'Monto aprobado', editing?.montoAprobado)}
          </div>

          <div id="mo-estimado-wrap" ${estado === 'pendiente' ? '' : 'hidden'}>
            ${montoGroupHTML('mo-estim', 'Monto estimado (mientras se resuelve)', editing?.montoEstimado)}
          </div>

          <label for="mo-oc">N° Orden de compra</label>
          <input type="text" id="mo-oc" value="${escapeHTML(editing?.numeroOC || '')}" />

          <label for="mo-causada">Causada por</label>
          <input type="text" id="mo-causada" placeholder="Ej: Solicitud de ENEX" value="${escapeHTML(editing?.causadaPor || '')}" />

          <label for="mo-obs">Observaciones</label>
          <textarea id="mo-obs" maxlength="500">${escapeHTML(editing?.observaciones || '')}</textarea>

          <div class="ssma-form-actions">
            ${editingId ? '<button type="button" class="btn btn-secondary" id="mo-cancel-edit">Cancelar edición</button>' : ''}
            <button type="submit" class="btn btn-primary">${editingId ? 'Guardar cambios' : 'Guardar'}</button>
          </div>
        </form>

        <h2 class="ssma-history-title">Historial</h2>
        ${items.length ? `
          <section class="ssma-history-list">
            ${items.map((m) => `
              <div class="ssma-history-row">
                <button type="button" class="ssma-history-main" data-edit-id="${m.id}">
                  <span class="ssma-history-date">${m.numero ? `N° ${escapeHTML(m.numero)} — ` : ''}${formatDateEs(m.fechaPresentacion)}</span>
                  <span class="ssma-history-count">${escapeHTML(m.descripcion || '(sin descripción)')}</span>
                  <span class="ssma-history-split">${TIPO_LABEL[m.tipo] || m.tipo} · ${SUBTIPO_LABEL[m.subtipo] || m.subtipo} · ${ESTADO_LABEL[m.estado] || m.estado} · ${formatMonto(costosMontoTotal(m.montoPresentado))}</span>
                </button>
                <button type="button" class="icon-btn ssma-delete-btn" data-delete-id="${m.id}" title="Eliminar">🗑️</button>
              </div>
            `).join('')}
          </section>
        ` : `
          <div class="empty-state">
            <p>Todavía no hay modificaciones cargadas.</p>
          </div>
        `}
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate(`/costos/obra/${obraId}`));

    container.querySelector('#mo-estado').addEventListener('change', (e) => {
      container.querySelector('#mo-aprobado-wrap').hidden = e.target.value !== 'aprobada';
      container.querySelector('#mo-estimado-wrap').hidden = e.target.value !== 'pendiente';
    });

    const cancelBtn = container.querySelector('#mo-cancel-edit');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { editingId = null; paint(); });

    container.querySelector('#mo-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fields = {
        numero: container.querySelector('#mo-numero').value.trim(),
        descripcion: container.querySelector('#mo-descripcion').value.trim(),
        fechaPresentacion: container.querySelector('#mo-fecha').value,
        tipo: container.querySelector('#mo-tipo').value,
        subtipo: container.querySelector('#mo-subtipo').value,
        montoPresentado: readMontoGroup(container, 'mo-pres'),
        estado: container.querySelector('#mo-estado').value,
        montoAprobado: readMontoGroup(container, 'mo-aprob'),
        montoEstimado: readMontoGroup(container, 'mo-estim'),
        numeroOC: container.querySelector('#mo-oc').value.trim(),
        causadaPor: container.querySelector('#mo-causada').value.trim(),
        observaciones: container.querySelector('#mo-obs').value.trim(),
      };

      let saved;
      if (editingId) {
        saved = await updateCostosModificacion(editingId, fields);
        toast('Modificación actualizada.');
        editingId = null;
      } else {
        saved = await addCostosModificacion({ obraId, ...fields });
        toast('Modificación guardada.');
      }

      if (obra.costosDriveFolderId) {
        const ok = await uploadModificacion(obra.costosDriveFolderId, saved);
        if (!ok) toast('⚠️ No se pudo subir a Drive (quedó guardado en tu teléfono, se reintenta después).');
      }

      items = await getCostosModificacionesByObra(obraId);
      paint();
    });

    container.querySelectorAll('.ssma-history-main').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingId = btn.dataset.editId;
        paint();
        container.querySelector('#mo-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    container.querySelectorAll('.ssma-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('¿Eliminar esta modificación? No se puede deshacer. Ojo: si estaba compartida con el equipo, la copia en Drive no se borra sola.');
        if (!ok) return;
        await deleteCostosModificacion(btn.dataset.deleteId);
        if (editingId === btn.dataset.deleteId) editingId = null;
        items = await getCostosModificacionesByObra(obraId);
        toast('Modificación eliminada.');
        paint();
      });
    });
  }

  paint();

  if (obra.costosDriveFolderId) {
    syncFromDrive({ auto: true });
  }
}
