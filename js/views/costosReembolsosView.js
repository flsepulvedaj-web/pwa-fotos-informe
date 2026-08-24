import {
  getObra,
  getCostosReembolsosByObra,
  addCostosReembolso,
  updateCostosReembolso,
  deleteCostosReembolso,
} from '../db.js';
import { isSignedIn } from '../googleDrive.js';
import { uploadReembolso, syncReembolsosFromDrive } from '../costosSync.js';
import { navigate } from '../router.js';
import { escapeHTML, confirmDialog, toast } from '../utils.js';
import { formatMonto } from '../costosDashboard.js';

function formatDateEs(iso) {
  if (!iso) return '—';
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Listado de reembolsos solicitados por la constructora — el más simple de
 * los 3 (formulario + historial, sin subgrupos de montos). Sin fecha de
 * pago = todavía pendiente.
 */
export async function renderCostosReembolsosView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/costos');
    return;
  }

  let items = await getCostosReembolsosByObra(obraId);
  let editingId = null;

  async function syncFromDrive({ auto }) {
    if (!obra.costosDriveFolderId) return;
    if (auto && !isSignedIn()) return;
    try {
      const changed = await syncReembolsosFromDrive(obraId, obra.costosDriveFolderId);
      items = await getCostosReembolsosByObra(obraId);
      if (changed) {
        toast(`📥 ${changed} reembolso(s) traído(s) de Drive.`);
        paint();
      } else if (!auto) {
        toast('Ya tenés todo lo más reciente.');
      }
    } catch (err) {
      console.error('Error sincronizando reembolsos desde Drive:', err);
      if (!auto) toast('No se pudo conectar con Drive.');
    }
  }

  function paint() {
    const editing = editingId ? items.find((r) => r.id === editingId) : null;

    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Reembolsos — ${escapeHTML(obra.name)}</span>
      </header>
      <main class="view-content">
        <form class="ssma-form" id="reemb-form">
          <h2>${editingId ? 'Editar reembolso' : 'Nueva solicitud de reembolso'}</h2>

          <label for="r-numero">N°</label>
          <input type="text" id="r-numero" value="${escapeHTML(editing?.numero || '')}" />

          <label for="r-descripcion">Descripción</label>
          <input type="text" id="r-descripcion" value="${escapeHTML(editing?.descripcion || '')}" />

          <label for="r-sin-iva">Monto sin IVA</label>
          <input type="number" id="r-sin-iva" min="0" step="1" inputmode="decimal" value="${editing?.montoSinIva ?? ''}" />

          <label for="r-con-iva">Monto con IVA</label>
          <input type="number" id="r-con-iva" min="0" step="1" inputmode="decimal" value="${editing?.montoConIva ?? ''}" />

          <label for="r-fecha-sol">Fecha de solicitud</label>
          <input type="date" id="r-fecha-sol" value="${editing?.fechaSolicitud || todayLocalISO()}" />

          <label for="r-fecha-pago">Fecha de pago (vacío = pendiente)</label>
          <input type="date" id="r-fecha-pago" value="${editing?.fechaPago || ''}" />

          <div class="ssma-form-actions">
            ${editingId ? '<button type="button" class="btn btn-secondary" id="r-cancel-edit">Cancelar edición</button>' : ''}
            <button type="submit" class="btn btn-primary">${editingId ? 'Guardar cambios' : 'Guardar'}</button>
          </div>
        </form>

        <h2 class="ssma-history-title">Historial</h2>
        ${items.length ? `
          <section class="ssma-history-list">
            ${items.map((r) => `
              <div class="ssma-history-row">
                <button type="button" class="ssma-history-main" data-edit-id="${r.id}">
                  <span class="ssma-history-date">${r.numero ? `N° ${escapeHTML(r.numero)} — ` : ''}${formatDateEs(r.fechaSolicitud)}</span>
                  <span class="ssma-history-count">${escapeHTML(r.descripcion || '(sin descripción)')} — ${formatMonto(r.montoConIva)}</span>
                  <span class="ssma-history-split">${r.fechaPago ? `✅ Pagado ${formatDateEs(r.fechaPago)}` : '⏳ Pendiente de pago'}</span>
                </button>
                <button type="button" class="icon-btn ssma-delete-btn" data-delete-id="${r.id}" title="Eliminar">🗑️</button>
              </div>
            `).join('')}
          </section>
        ` : `
          <div class="empty-state">
            <p>Todavía no hay reembolsos solicitados.</p>
          </div>
        `}
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate(`/costos/obra/${obraId}`));

    const cancelBtn = container.querySelector('#r-cancel-edit');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { editingId = null; paint(); });

    container.querySelector('#reemb-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const num = (id) => Math.max(0, parseFloat(container.querySelector(id).value) || 0);
      const fields = {
        numero: container.querySelector('#r-numero').value.trim(),
        descripcion: container.querySelector('#r-descripcion').value.trim(),
        montoSinIva: num('#r-sin-iva'),
        montoConIva: num('#r-con-iva'),
        fechaSolicitud: container.querySelector('#r-fecha-sol').value,
        fechaPago: container.querySelector('#r-fecha-pago').value || null,
      };

      if (!fields.fechaSolicitud) {
        toast('Elegí una fecha de solicitud.');
        return;
      }

      let saved;
      if (editingId) {
        saved = await updateCostosReembolso(editingId, fields);
        toast('Reembolso actualizado.');
        editingId = null;
      } else {
        saved = await addCostosReembolso({ obraId, ...fields });
        toast('Reembolso guardado.');
      }

      if (obra.costosDriveFolderId) {
        const ok = await uploadReembolso(obra.costosDriveFolderId, saved);
        if (!ok) toast('⚠️ No se pudo subir a Drive (quedó guardado en tu teléfono, se reintenta después).');
      }

      items = await getCostosReembolsosByObra(obraId);
      paint();
    });

    container.querySelectorAll('.ssma-history-main').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingId = btn.dataset.editId;
        paint();
        container.querySelector('#reemb-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    container.querySelectorAll('.ssma-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('¿Eliminar este reembolso? No se puede deshacer. Ojo: si estaba compartido con el equipo, la copia en Drive no se borra sola.');
        if (!ok) return;
        await deleteCostosReembolso(btn.dataset.deleteId);
        if (editingId === btn.dataset.deleteId) editingId = null;
        items = await getCostosReembolsosByObra(obraId);
        toast('Reembolso eliminado.');
        paint();
      });
    });
  }

  paint();

  if (obra.costosDriveFolderId) {
    syncFromDrive({ auto: true });
  }
}
