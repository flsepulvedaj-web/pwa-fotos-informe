import {
  getObra,
  getCostosContrato,
  getCostosModificacionesByObra,
  getCostosFacturasByObra,
  getCostosReembolsosByObra,
} from '../db.js';
import {
  computePresupuestoVigente,
  computeTotalFacturado,
  computeAvanceFinancieroPercent,
  computeModificacionesPendientes,
  computeReembolsosPendientes,
  formatMonto,
} from '../costosDashboard.js';
import { isSignedIn } from '../googleDrive.js';
import {
  syncContratoFromDrive,
  syncModificacionesFromDrive,
  syncFacturasFromDrive,
  syncReembolsosFromDrive,
} from '../costosSync.js';
import { navigate } from '../router.js';
import { escapeHTML, toast } from '../utils.js';

/**
 * Pantalla principal de Costos para una obra: dashboard de KPI arriba
 * (presupuesto vigente, facturado acumulado, % avance financiero,
 * modificaciones y reembolsos pendientes) + accesos a cada sección abajo.
 * Mismo esqueleto que controlObraView.js — al abrir, sincroniza en segundo
 * plano lo que haya en la carpeta de Drive vinculada.
 */
export async function renderCostosObraView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  const sections = [
    { id: 'contrato', icon: '📄', title: 'Contrato', desc: 'Presupuesto, moneda y retenciones' },
    { id: 'modificaciones', icon: '📈', title: 'Modificaciones', desc: 'Aumentos, disminuciones y proformas' },
    { id: 'facturacion', icon: '🧾', title: 'Facturación', desc: 'Facturas contractuales y de modificaciones' },
    { id: 'reembolsos', icon: '💵', title: 'Reembolsos', desc: 'Solicitudes de pago a la constructora' },
  ];

  async function loadData() {
    const [contrato, modificaciones, facturas, reembolsos] = await Promise.all([
      getCostosContrato(obraId),
      getCostosModificacionesByObra(obraId),
      getCostosFacturasByObra(obraId),
      getCostosReembolsosByObra(obraId),
    ]);
    return { contrato, modificaciones, facturas, reembolsos };
  }

  let data = await loadData();

  function paint() {
    const moneda = data.contrato?.moneda || '$';
    const presupuestoVigente = computePresupuestoVigente(data.contrato, data.modificaciones);
    const totalFacturado = computeTotalFacturado(data.facturas);
    const avancePercent = computeAvanceFinancieroPercent(totalFacturado, presupuestoVigente);
    const modPendientes = computeModificacionesPendientes(data.modificaciones);
    const reembolsosPendientes = computeReembolsosPendientes(data.reembolsos);

    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">${escapeHTML(obra.name)}</span>
      </header>
      <main class="view-content">
        <section class="kpi-tiles">
          <div class="kpi-tile">
            <div class="kpi-value">${presupuestoVigente ? formatMonto(presupuestoVigente, moneda) : '—'}</div>
            <div class="kpi-label">Presupuesto vigente</div>
          </div>
          <div class="kpi-tile">
            <div class="kpi-value">${totalFacturado ? formatMonto(totalFacturado, moneda) : '—'}</div>
            <div class="kpi-label">Facturado acumulado</div>
          </div>
          <div class="kpi-tile">
            <div class="kpi-value">${avancePercent !== null ? avancePercent + '%' : '—'}</div>
            <div class="kpi-label">Avance financiero</div>
          </div>
        </section>

        ${modPendientes.cantidad || reembolsosPendientes.cantidad ? `
          <section class="incumplimientos-panel">
            <h3>⚠️ Pendientes</h3>
            ${modPendientes.cantidad ? `
              <div class="incumplimiento-row">
                <div class="incumplimiento-main">
                  <span class="incumplimiento-tag">Modificaciones</span>
                  <span class="incumplimiento-label">${modPendientes.cantidad} sin aprobar</span>
                  <span class="incumplimiento-meta">${formatMonto(modPendientes.monto, moneda)} presentados</span>
                </div>
                <button type="button" class="btn btn-secondary" data-goto="modificaciones">Revisar</button>
              </div>
            ` : ''}
            ${reembolsosPendientes.cantidad ? `
              <div class="incumplimiento-row">
                <div class="incumplimiento-main">
                  <span class="incumplimiento-tag">Reembolsos</span>
                  <span class="incumplimiento-label">${reembolsosPendientes.cantidad} sin pagar</span>
                  <span class="incumplimiento-meta">${formatMonto(reembolsosPendientes.monto, moneda)} pendientes</span>
                </div>
                <button type="button" class="btn btn-secondary" data-goto="reembolsos">Revisar</button>
              </div>
            ` : ''}
          </section>
        ` : `
          <div class="incumplimientos-ok">✅ Sin pendientes abiertos</div>
        `}

        <section class="control-section-grid">
          ${sections.map((s) => `
            <button type="button" class="module-card control-section-card" data-section="${s.id}">
              <span class="module-icon">${s.icon}</span>
              <span class="module-title">${s.title}</span>
              <span class="module-desc">${s.desc}</span>
            </button>
          `).join('')}
        </section>
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate(`/control/obra/${obraId}`));

    container.querySelectorAll('[data-section]').forEach((card) => {
      card.addEventListener('click', () => navigate(`/costos/obra/${obraId}/${card.dataset.section}`));
    });

    container.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => navigate(`/costos/obra/${obraId}/${btn.dataset.goto}`));
    });
  }

  paint();

  // Sincroniza en segundo plano lo que haya en la carpeta de Drive
  // vinculada — nunca dispara el popup de sesión de Google (isSignedIn).
  if (obra.costosDriveFolderId && isSignedIn()) {
    (async () => {
      try {
        const [c1, c2, c3, c4] = await Promise.all([
          syncContratoFromDrive(obraId, obra.costosDriveFolderId),
          syncModificacionesFromDrive(obraId, obra.costosDriveFolderId),
          syncFacturasFromDrive(obraId, obra.costosDriveFolderId),
          syncReembolsosFromDrive(obraId, obra.costosDriveFolderId),
        ]);
        if (c1 || c2 || c3 || c4) {
          data = await loadData();
          toast('🔄 Dashboard de Costos actualizado.');
          paint();
        }
      } catch (err) {
        console.error('Error sincronizando dashboard de Costos:', err);
      }
    })();
  }
}
