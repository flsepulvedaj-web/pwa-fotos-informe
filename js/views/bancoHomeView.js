import { getSignedInEmail } from '../googleDrive.js';
import { modulesForEmail, getCachedPermissions } from '../permissions.js';
import { navigate } from '../router.js';

/**
 * Macro módulo "Banco": agrupa Avance de obra (el ex-módulo "Proyectos",
 * renombrado) + los futuros Informes técnicos y Research.
 */
export async function renderBancoHomeView(container) {
  const email = await getSignedInEmail();
  const allowed = modulesForEmail(email, getCachedPermissions());

  const fotosOk = allowed.includes('fotos');
  const sections = [
    { id: 'fotos', route: fotosOk ? '/fotos' : null, icon: '📷', title: 'Avance de obra', desc: 'Fotos de obra → informe PDF', ready: fotosOk },
    { id: 'informes-tecnicos', route: null, icon: '📄', title: 'Informes técnicos', desc: 'Próximamente', ready: false },
    { id: 'research', route: null, icon: '🔬', title: 'Research', desc: 'Próximamente', ready: false },
  ];

  container.innerHTML = `
    <header class="app-header">
      <button class="icon-btn" id="btn-back-home" title="Volver al inicio">←</button>
      <span class="header-title">Banco</span>
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
      // Los "Próximamente" no tienen ruta — no hacen nada al tocarlos.
    });
  });
}
