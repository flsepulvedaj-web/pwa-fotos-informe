import { getSignedInEmail } from '../googleDrive.js';
import { modulesForEmail, getCachedPermissions } from '../permissions.js';
import { navigate } from '../router.js';

/**
 * Macro módulo "Proyectos" (nuevo — no confundir con el ex-módulo
 * "Proyectos" que ahora se llama "Avance de obra" y vive en Banco):
 * agrupa Protocolos + Control + el futuro Zona (zonificación/georreferenciación).
 */
export async function renderProyectosHomeView(container) {
  const email = await getSignedInEmail();
  const allowed = modulesForEmail(email, getCachedPermissions());

  const protocolosOk = allowed.includes('protocolos');
  const controlOk = allowed.includes('control');
  const sections = [
    { route: protocolosOk ? '/protocolos' : null, icon: '📋', title: 'Protocolos', desc: 'Checklist de calidad + firma digital', ready: protocolosOk },
    { route: controlOk ? '/control' : null, icon: '🎛️', title: 'Control', desc: 'Programación, SSMA, actas y KPI de obra', ready: controlOk },
    { route: null, icon: '📍', title: 'Zona', desc: 'Próximamente', ready: false },
  ];

  container.innerHTML = `
    <header class="app-header">
      <button class="icon-btn" id="btn-back-home" title="Volver al inicio">←</button>
      <span class="header-title">Proyectos</span>
    </header>
    <main class="view-content">
      <section class="control-section-grid">
        ${sections.map((s) => `
          <button type="button" class="module-card control-section-card${s.ready ? '' : ' control-section-soon'}" data-route="${s.route || ''}">
            <span class="module-icon">${s.icon}</span>
            <span class="module-title">${s.title}</span>
            <span class="module-desc">${s.ready ? s.desc : 'Próximamente'}</span>
          </button>
        `).join('')}
      </section>
    </main>
  `;

  container.querySelector('#btn-back-home').addEventListener('click', () => navigate('/'));

  container.querySelectorAll('.control-section-card').forEach((card) => {
    card.addEventListener('click', () => {
      if (card.dataset.route) navigate(card.dataset.route);
    });
  });
}
