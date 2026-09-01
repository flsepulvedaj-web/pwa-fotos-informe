import {
  getObra,
  costosFacturaMontoNeto,
  getCostosFacturasByObra,
  addCostosFactura,
  updateCostosFactura,
  deleteCostosFactura,
} from '../db.js';
import { isSignedIn } from '../googleDrive.js';
import { uploadFactura, syncFacturasFromDrive } from '../costosSync.js';
import { parseEstadoPagoXLSX } from '../costosEstadoPagoParser.js';
import { navigate } from '../router.js';
import { escapeHTML, confirmDialog, toast } from '../utils.js';
import { formatMonto } from '../costosDashboard.js';

const TIPO_LABEL = { contractual: 'Contractual', modificaciones: 'Modificaciones' };

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
 * Estados de pago (EP): formulario para agregar/editar + historial — mismo
 * patrón que Personal en obra. Pancho no cobra por "facturas" sueltas, cobra
 * por Estados de Pago (de ahí el nombre que ve el usuario — internamente la
 * ruta/archivo se sigue llamando "facturacion", no vale la pena renombrarlo).
 * El monto neto de cada EP se calcula siempre desde los montos del período
 * (avance − anticipo − retención + reajuste), nunca se guarda aparte, así no
 * puede quedar desincronizado. Los acumulados (para el dashboard) se
 * calculan sumando cronológicamente.
 */
export async function renderCostosFacturacionView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  let items = await getCostosFacturasByObra(obraId);
  let editingId = null;

  async function syncFromDrive({ auto }) {
    if (!obra.costosDriveFolderId) return;
    if (auto && !isSignedIn()) return;
    try {
      const changed = await syncFacturasFromDrive(obraId, obra.costosDriveFolderId);
      items = await getCostosFacturasByObra(obraId);
      if (changed) {
        toast(`📥 ${changed} estado(s) de pago traído(s) de Drive.`);
        paint();
      } else if (!auto) {
        toast('Ya tenés todo lo más reciente.');
      }
    } catch (err) {
      console.error('Error sincronizando estados de pago desde Drive:', err);
      if (!auto) toast('No se pudo conectar con Drive.');
    }
  }

  function paint() {
    const editing = editingId ? items.find((f) => f.id === editingId) : null;

    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Estados de pago — ${escapeHTML(obra.name)}</span>
      </header>
      <main class="view-content">
        <form class="ssma-form" id="fact-form">
          <h2>${editingId ? 'Editar estado de pago' : 'Nuevo estado de pago'}</h2>

          <input type="file" id="ep-file-input" accept=".xlsx,.xls" style="display:none" />
          <div class="ssma-form-actions">
            <button type="button" class="btn btn-secondary" id="btn-upload-ep">📄 Cargar desde Excel (rellena el formulario)</button>
          </div>
          <p class="avance-tree-hint">Subí el Excel del contratista y completa los campos solo — revisalos y apretá "Guardar" para dejarlo en el historial.</p>

          <label for="f-tipo">Tipo</label>
          <select id="f-tipo">
            <option value="contractual" ${(editing?.tipo || 'contractual') === 'contractual' ? 'selected' : ''}>Contractual</option>
            <option value="modificaciones" ${editing?.tipo === 'modificaciones' ? 'selected' : ''}>Modificaciones</option>
          </select>

          <label for="f-item">Ítem</label>
          <input type="text" id="f-item" placeholder="Ej: EPP N°1" value="${escapeHTML(editing?.item || '')}" />

          <label for="f-descripcion">Descripción</label>
          <input type="text" id="f-descripcion" value="${escapeHTML(editing?.descripcion || '')}" />

          <label for="f-numero">N° Factura</label>
          <input type="text" id="f-numero" value="${escapeHTML(editing?.numeroFactura || '')}" />

          <label for="f-fecha">Fecha</label>
          <input type="date" id="f-fecha" value="${editing?.fecha || todayLocalISO()}" />

          <label for="f-tc">Tipo de cambio</label>
          <input type="number" id="f-tc" min="0" step="0.01" inputmode="decimal" value="${editing?.tc ?? 1}" />

          <label for="f-avance">Avance neto del período</label>
          <input type="number" id="f-avance" min="0" step="1" inputmode="decimal" value="${editing?.avanceNetoPeriodo ?? ''}" />

          <label for="f-anticipo">Anticipo del período</label>
          <input type="number" id="f-anticipo" min="0" step="1" inputmode="decimal" value="${editing?.anticipoPeriodo ?? ''}" />

          <label for="f-retencion">Retención del período</label>
          <input type="number" id="f-retencion" min="0" step="1" inputmode="decimal" value="${editing?.retencionPeriodo ?? ''}" />

          <label for="f-reajuste">Reajuste del período</label>
          <input type="number" id="f-reajuste" min="0" step="1" inputmode="decimal" value="${editing?.reajustePeriodo ?? ''}" />

          <div class="ssma-form-actions">
            ${editingId ? '<button type="button" class="btn btn-secondary" id="f-cancel-edit">Cancelar edición</button>' : ''}
            <button type="submit" class="btn btn-primary">${editingId ? 'Guardar cambios' : 'Guardar'}</button>
          </div>
        </form>

        <h2 class="ssma-history-title">Historial</h2>
        ${items.length ? `
          <section class="ssma-history-list">
            ${items.map((f) => `
              <div class="ssma-history-row">
                <button type="button" class="ssma-history-main" data-edit-id="${f.id}">
                  <span class="ssma-history-date">${formatDateEs(f.fecha)} ${f.numeroFactura ? `— N° ${escapeHTML(f.numeroFactura)}` : ''}</span>
                  <span class="ssma-history-count">${escapeHTML(f.item || f.descripcion || '(sin descripción)')}</span>
                  <span class="ssma-history-split">${TIPO_LABEL[f.tipo] || f.tipo} · Monto neto: ${formatMonto(costosFacturaMontoNeto(f))}</span>
                </button>
                <button type="button" class="icon-btn ssma-delete-btn" data-delete-id="${f.id}" title="Eliminar">🗑️</button>
              </div>
            `).join('')}
          </section>
        ` : `
          <div class="empty-state">
            <p>Todavía no hay estados de pago cargados.</p>
          </div>
        `}
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate(`/costos/obra/${obraId}`));

    const cancelBtn = container.querySelector('#f-cancel-edit');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { editingId = null; paint(); });

    const epFileInput = container.querySelector('#ep-file-input');
    container.querySelector('#btn-upload-ep').addEventListener('click', () => epFileInput.click());
    epFileInput.addEventListener('change', async () => {
      const file = epFileInput.files?.[0];
      epFileInput.value = '';
      if (!file) return;
      try {
        const buffer = await file.arrayBuffer();
        const parsed = parseEstadoPagoXLSX(buffer);
        container.querySelector('#f-item').value = parsed.epNumber !== '' ? `EP N°${parsed.epNumber}` : '';
        container.querySelector('#f-numero').value = parsed.epNumber !== '' ? String(parsed.epNumber) : '';
        if (parsed.fecha) container.querySelector('#f-fecha').value = parsed.fecha;
        container.querySelector('#f-avance').value = parsed.avanceNetoPeriodo;
        container.querySelector('#f-anticipo').value = parsed.anticipoPeriodo;
        container.querySelector('#f-retencion').value = parsed.retencionPeriodo;
        toast(`Formulario completado desde "${file.name}" (hoja "${parsed.sheetUsed}") — revisá y guardá.`);
      } catch (err) {
        console.error('Error leyendo estado de pago:', err);
        toast(`⚠️ ${err.message || 'No se pudo leer el archivo.'}`);
      }
    });

    container.querySelector('#fact-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const num = (id) => Math.max(0, parseFloat(container.querySelector(id).value) || 0);
      const fields = {
        tipo: container.querySelector('#f-tipo').value,
        item: container.querySelector('#f-item').value.trim(),
        descripcion: container.querySelector('#f-descripcion').value.trim(),
        numeroFactura: container.querySelector('#f-numero').value.trim(),
        fecha: container.querySelector('#f-fecha').value,
        tc: num('#f-tc') || 1,
        avanceNetoPeriodo: num('#f-avance'),
        anticipoPeriodo: num('#f-anticipo'),
        retencionPeriodo: num('#f-retencion'),
        reajustePeriodo: num('#f-reajuste'),
      };

      if (!fields.fecha) {
        toast('Elegí una fecha.');
        return;
      }

      let saved;
      if (editingId) {
        saved = await updateCostosFactura(editingId, fields);
        toast('Estado de pago actualizado.');
        editingId = null;
      } else {
        saved = await addCostosFactura({ obraId, ...fields });
        toast('Estado de pago guardado.');
      }

      if (obra.costosDriveFolderId) {
        const ok = await uploadFactura(obra.costosDriveFolderId, saved);
        if (!ok) toast('⚠️ No se pudo subir a Drive (quedó guardado en tu teléfono, se reintenta después).');
      }

      items = await getCostosFacturasByObra(obraId);
      paint();
    });

    container.querySelectorAll('.ssma-history-main').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingId = btn.dataset.editId;
        paint();
        container.querySelector('#fact-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    container.querySelectorAll('.ssma-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('¿Eliminar este estado de pago? No se puede deshacer. Ojo: si estaba compartido con el equipo, la copia en Drive no se borra sola.');
        if (!ok) return;
        await deleteCostosFactura(btn.dataset.deleteId);
        if (editingId === btn.dataset.deleteId) editingId = null;
        items = await getCostosFacturasByObra(obraId);
        toast('Estado de pago eliminado.');
        paint();
      });
    });
  }

  paint();

  if (obra.costosDriveFolderId) {
    syncFromDrive({ auto: true });
  }
}
