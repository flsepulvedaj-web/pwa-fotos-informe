import { getObra, updateObra, getCostosContrato, saveCostosContrato } from '../db.js';
import { openFolderPicker, isSignedIn } from '../googleDrive.js';
import { uploadContrato, syncContratoFromDrive } from '../costosSync.js';
import { navigate } from '../router.js';
import { toast, escapeHTML } from '../utils.js';

/**
 * Configuración del contrato de una obra: presupuesto oficial, monto de
 * contrato, moneda/TC, y los porcentajes de anticipo y retención — son la
 * base sobre la que se calculan el resto de los KPI de Costos (presupuesto
 * vigente, % avance financiero). A diferencia de Modificaciones/
 * Facturación/Reembolsos, es un solo registro por obra, no un historial.
 */
export async function renderCostosContratoView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/costos');
    return;
  }

  let contrato = await getCostosContrato(obraId);

  async function syncFromDrive({ auto }) {
    if (!obra.costosDriveFolderId) return;
    if (auto && !isSignedIn()) return;
    try {
      const changed = await syncContratoFromDrive(obraId, obra.costosDriveFolderId);
      if (changed) {
        contrato = await getCostosContrato(obraId);
        toast('📥 Contrato actualizado desde Drive.');
        paint();
      } else if (!auto) {
        toast('Ya tenés lo más reciente.');
      }
    } catch (err) {
      console.error('Error sincronizando contrato desde Drive:', err);
      if (!auto) toast('No se pudo conectar con Drive.');
    }
  }

  function paint() {
    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Contrato — ${escapeHTML(obra.name)}</span>
      </header>
      <main class="view-content">
        <section class="avance-drive-link">
          ${obra.costosDriveFolderId ? `
            <div class="avance-drive-linked">☁️ Compartido en: <strong>${escapeHTML(obra.costosDriveFolderName)}</strong></div>
            <div class="avance-drive-actions">
              <button type="button" class="btn btn-secondary" id="btn-check-drive">🔄 Buscar cambios</button>
              <button type="button" class="btn btn-secondary" id="btn-change-drive-folder">Cambiar carpeta</button>
            </div>
          ` : `
            <button type="button" class="btn btn-primary" id="btn-link-drive-folder">🔗 Compartir con el equipo (Drive)</button>
            <p class="avance-upload-hint">Vinculá una carpeta de Drive — esta misma se va a usar para Modificaciones, Facturación y Reembolsos de esta obra.</p>
          `}
        </section>

        <form class="ssma-form" id="contrato-form">
          <h2>Datos del contrato</h2>

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
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate(`/costos/obra/${obraId}`));

    const linkFolder = async () => {
      try {
        const picked = await openFolderPicker();
        if (!picked) return;
        await updateObra(obraId, { costosDriveFolderId: picked.id, costosDriveFolderName: picked.name });
        obra.costosDriveFolderId = picked.id;
        obra.costosDriveFolderName = picked.name;
        toast(`Carpeta vinculada: "${picked.name}".`);
        paint();
        syncFromDrive({ auto: false });
      } catch (err) {
        console.error(err);
        toast('No se pudo conectar con Google Drive.');
      }
    };
    container.querySelector('#btn-link-drive-folder')?.addEventListener('click', linkFolder);
    container.querySelector('#btn-change-drive-folder')?.addEventListener('click', linkFolder);
    container.querySelector('#btn-check-drive')?.addEventListener('click', () => syncFromDrive({ auto: false }));

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
      toast('Contrato guardado.');

      if (obra.costosDriveFolderId) {
        const ok = await uploadContrato(obra.costosDriveFolderId, contrato);
        if (!ok) toast('⚠️ No se pudo subir a Drive (quedó guardado en tu teléfono, se reintenta después).');
      }
    });
  }

  paint();

  if (obra.costosDriveFolderId) {
    syncFromDrive({ auto: true });
  }
}
