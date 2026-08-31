import { getObra, updateObra, getCostosContrato, saveCostosContrato, getCostosPresupuestoDetalle, saveCostosPresupuestoDetalle, deleteCostosPresupuestoDetalle } from '../db.js';
import { openFolderPicker, isSignedIn, getSignedInEmail } from '../googleDrive.js';
import { uploadContrato, syncContratoFromDrive } from '../costosSync.js';
import { uploadObrasIndex } from '../obraSync.js';
import { isAdmin } from '../permissions.js';
import { driveLinkSectionHTML, wireDriveLinkSection } from '../driveLinkSection.js';
import { parsePresupuestoDetalleXLSX } from '../costosPresupuestoParser.js';
import { formatMonto } from '../costosDashboard.js';
import { navigate } from '../router.js';
import { toast, escapeHTML } from '../utils.js';

/**
 * Presupuesto de una obra: presupuesto oficial, monto de contrato, moneda/
 * TC, y los porcentajes de anticipo y retención — son la base sobre la que
 * se calculan el resto de los KPI de Costos (presupuesto vigente, % avance
 * financiero). A diferencia de Modificaciones/Estados de pago/Reembolsos,
 * es un solo registro por obra, no un historial (por eso se llama
 * "Presupuesto" para el usuario, aunque la ruta/archivo interno se sigan
 * llamando "contrato" — no vale la pena renombrarlos por esto).
 */
export async function renderCostosContratoView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  const admin = isAdmin(await getSignedInEmail());
  let contrato = await getCostosContrato(obraId);
  let presupuestoDetalle = await getCostosPresupuestoDetalle(obraId);

  function renderPresupuestoDetalleHTML() {
    if (!presupuestoDetalle || !presupuestoDetalle.items?.length) {
      return '<p class="avance-tree-hint">Todavía no se subió ningún desglose de partidas.</p>';
    }
    const groups = new Map();
    for (const it of presupuestoDetalle.items) {
      const key = it.categoria || '—';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    const rowsHTML = (items) =>
      items
        .map(
          (i) => `
        <tr>
          <td>${escapeHTML(i.item)}</td>
          <td>${escapeHTML(i.descripcion)}</td>
          <td>${escapeHTML(i.unidad)}</td>
          <td>${i.cantidad !== '' ? i.cantidad : ''}</td>
          <td>${i.precioUnitario !== '' ? formatMonto(i.precioUnitario) : ''}</td>
          <td>${formatMonto(i.total)}</td>
        </tr>`
        )
        .join('');
    const groupsHTML = [...groups.entries()]
      .map(([cat, items]) => {
        const catTotal = items.reduce((s, i) => s + i.total, 0);
        return `
        <details class="presupuesto-cat">
          <summary>Categoría ${escapeHTML(cat)} — ${formatMonto(catTotal)} (${items.length} partida${items.length === 1 ? '' : 's'})</summary>
          <div class="avance-table-wrap">
            <table class="avance-table">
              <thead><tr><th>Ítem</th><th>Descripción</th><th>Unidad</th><th>Cant.</th><th>P. Unitario</th><th>Total</th></tr></thead>
              <tbody>${rowsHTML(items)}</tbody>
            </table>
          </div>
        </details>`;
      })
      .join('');
    return `
      <p class="avance-tree-hint">
        ${presupuestoDetalle.items.length} partidas · Total: <strong>${formatMonto(presupuestoDetalle.grandTotal)}</strong>
        ${presupuestoDetalle.sourceFileName ? ` · Archivo: ${escapeHTML(presupuestoDetalle.sourceFileName)}` : ''}
      </p>
      ${groupsHTML}
    `;
  }

  async function syncFromDrive({ auto }) {
    if (!obra.costosDriveFolderId) return;
    if (auto && !isSignedIn()) return;
    try {
      const changed = await syncContratoFromDrive(obraId, obra.costosDriveFolderId);
      if (changed) {
        contrato = await getCostosContrato(obraId);
        toast('📥 Presupuesto actualizado desde Drive.');
        paint();
      } else if (!auto) {
        toast('Ya tenés lo más reciente.');
      }
    } catch (err) {
      console.error('Error sincronizando presupuesto desde Drive:', err);
      if (!auto) toast('No se pudo conectar con Drive.');
    }
  }

  function paint() {
    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Presupuesto — ${escapeHTML(obra.name)}</span>
      </header>
      <main class="view-content">
        ${driveLinkSectionHTML({
          admin,
          folderId: obra.costosDriveFolderId,
          folderName: obra.costosDriveFolderName,
          hintText: 'Vinculá una carpeta de Drive — esta misma se va a usar para Modificaciones, Estados de pago y Reembolsos de esta obra.',
        })}

        <form class="ssma-form" id="contrato-form">
          <h2>Datos del presupuesto</h2>

          <label for="c-presupuesto">Presupuesto oficial</label>
          <input type="number" id="c-presupuesto" min="0" step="1" inputmode="decimal" />

          <label for="c-monto">Monto contrato</label>
          <input type="number" id="c-monto" min="0" step="1" inputmode="decimal" />

          <label for="c-moneda">Moneda</label>
          <input type="text" id="c-moneda" maxlength="6" placeholder="$" />

          <label for="c-tc">Tipo de cambio</label>
          <input type="number" id="c-tc" min="0" step="0.01" inputmode="decimal" />

          <label for="c-anticipo">% Anticipo</label>
          <input type="number" id="c-anticipo" min="0" max="100" step="0.1" inputmode="decimal" />

          <label for="c-retencion-periodo">% Retención por período</label>
          <input type="number" id="c-retencion-periodo" min="0" max="100" step="0.1" inputmode="decimal" />

          <label for="c-retencion-total">% Retención total contrato</label>
          <input type="number" id="c-retencion-total" min="0" max="100" step="0.1" inputmode="decimal" />

          <div class="ssma-form-actions">
            <button type="submit" class="btn btn-primary">Guardar</button>
          </div>
        </form>

        <section class="ssma-form" id="presupuesto-detalle-section">
          <h2>Desglose de partidas (presupuesto original)</h2>
          <p class="avance-tree-hint">Subí el Excel del contratista con el detalle de partidas (columnas Unidad, Cantidad, P. Unitario y Total) — queda guardado como referencia del presupuesto original, aparte del monto de arriba.</p>
          <input type="file" id="presupuesto-file-input" accept=".xlsx,.xls" style="display:none" />
          <div class="ssma-form-actions">
            <button type="button" class="btn btn-secondary" id="btn-upload-presupuesto">📄 Subir desglose (Excel)</button>
            ${presupuestoDetalle ? '<button type="button" class="btn btn-secondary" id="btn-delete-presupuesto">🗑️ Quitar desglose</button>' : ''}
          </div>
          ${renderPresupuestoDetalleHTML()}
        </section>
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate(`/costos/obra/${obraId}`));

    wireDriveLinkSection(container, {
      onLink: async () => {
        try {
          const picked = await openFolderPicker();
          if (!picked) return;
          await updateObra(obraId, { costosDriveFolderId: picked.id, costosDriveFolderName: picked.name });
          obra.costosDriveFolderId = picked.id;
          obra.costosDriveFolderName = picked.name;
          uploadObrasIndex(); // best-effort — le llega al resto del equipo sin esperar a que abran Control
          toast(`Carpeta vinculada: "${picked.name}".`);
          paint();
          syncFromDrive({ auto: false });
        } catch (err) {
          console.error(err);
          toast('No se pudo conectar con Google Drive.');
        }
      },
      onSync: () => syncFromDrive({ auto: false }),
    });

    container.querySelector('#c-presupuesto').value = contrato?.presupuestoOficial ?? '';
    container.querySelector('#c-monto').value = contrato?.montoContrato ?? '';
    container.querySelector('#c-moneda').value = contrato?.moneda ?? '$';
    container.querySelector('#c-tc').value = contrato?.tcContrato ?? 1;
    container.querySelector('#c-anticipo').value = contrato?.anticipoPct ?? '';
    container.querySelector('#c-retencion-periodo').value = contrato?.retencionPeriodoPct ?? '';
    container.querySelector('#c-retencion-total').value = contrato?.retencionTotalContratoPct ?? '';

    container.querySelector('#contrato-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const num = (id) => Math.max(0, parseFloat(container.querySelector(id).value) || 0);
      contrato = await saveCostosContrato({
        obraId,
        presupuestoOficial: num('#c-presupuesto'),
        montoContrato: num('#c-monto'),
        moneda: container.querySelector('#c-moneda').value.trim() || '$',
        tcContrato: num('#c-tc') || 1,
        anticipoPct: num('#c-anticipo'),
        retencionPeriodoPct: num('#c-retencion-periodo'),
        retencionTotalContratoPct: num('#c-retencion-total'),
      });
      toast('Presupuesto guardado.');

      if (obra.costosDriveFolderId) {
        const ok = await uploadContrato(obra.costosDriveFolderId, contrato);
        if (!ok) toast('⚠️ No se pudo subir a Drive (quedó guardado en tu teléfono, se reintenta después).');
      }
    });

    const fileInput = container.querySelector('#presupuesto-file-input');
    container.querySelector('#btn-upload-presupuesto').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      try {
        const buffer = await file.arrayBuffer();
        const { items, grandTotal, sheetUsed } = parsePresupuestoDetalleXLSX(buffer);
        const montoRef = contrato?.montoContrato || contrato?.presupuestoOficial || 0;
        if (montoRef > 0 && Math.abs(grandTotal - montoRef) > montoRef * 0.01) {
          const seguir = confirm(
            `Ojo: el desglose que subiste suma ${formatMonto(grandTotal)}, pero el Presupuesto/Monto contrato guardado arriba dice ${formatMonto(montoRef)} — no coinciden. ¿Guardar igual?`
          );
          if (!seguir) return;
        }
        presupuestoDetalle = await saveCostosPresupuestoDetalle({
          obraId,
          items,
          grandTotal,
          sourceFileName: file.name,
        });
        toast(`Desglose guardado: ${items.length} partidas (hoja "${sheetUsed}").`);
        paint();
      } catch (err) {
        console.error('Error leyendo desglose de presupuesto:', err);
        toast(`⚠️ ${err.message || 'No se pudo leer el archivo.'}`);
      }
    });

    const deleteBtn = container.querySelector('#btn-delete-presupuesto');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        if (!confirm('¿Quitar el desglose de partidas guardado? El monto de presupuesto de arriba no se toca.')) return;
        await deleteCostosPresupuestoDetalle(obraId);
        presupuestoDetalle = null;
        toast('Desglose eliminado.');
        paint();
      });
    }
  }

  paint();

  if (obra.costosDriveFolderId) {
    syncFromDrive({ auto: true });
  }
}
