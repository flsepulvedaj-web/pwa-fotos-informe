import { getAllObras, createObra } from '../db.js';
import { navigate } from '../router.js';
import { promptDialog, toast, escapeHTML } from '../utils.js';

/**
 * Pantalla de inicio del módulo Control: lista de obras (las mismas que usa
 * Protocolos — misma tabla `obras`, mismo id). Cada obra tiene su propio
 * dashboard de KPI, programación, checklist diario, SSMA y actas.
 */
export async function renderControlHomeView(container) {
  const obras = await getAllObras();

  container.innerHTML = `
    <header class="app-header">
      <button class="icon-btn" id="btn-back-home" title="Volver al inicio">←</button>
      <span class="header-title">Control</span>
    </header>
    <main class="view-content">
      ${obras.length ? `
        <section class="obra-grid">
          ${obras.map((o) => `
            <button class="obra-tile" data-obra-id="${o.id}">
              <span class="obra-icon">🎛️</span>
              <span class="obra-name">${escapeHTML(o.name)}</span>
            </button>
          `).join('')}
        </section>
      ` : `
        <div class="empty-state">
          <p>Todavía no hay obras.</p>
          <p>Crea una para empezar a llevar su control.</p>
        </div>
      `}
    </main>
    <div class="fab-row">
      <button class="fab fab-primary" id="btn-new-obra" title="Nueva obra">🏗️➕</button>
    </div>
  `;

  container.querySelector('#btn-back-home').addEventListener('click', () => navigate('/'));

  container.querySelectorAll('.obra-tile').forEach((tile) => {
    tile.addEventListener('click', () => navigate(`/control/obra/${tile.dataset.obraId}`));
  });

  container.querySelector('#btn-new-obra').addEventListener('click', async () => {
    const result = await promptDialog({
      title: 'Nueva obra',
      fields: [{ name: 'name', label: 'Nombre de la obra', placeholder: 'Ej: Villa Los Aromos' }],
      confirmLabel: 'Crear',
    });
    if (result && result.name) {
      await createObra(result.name);
      toast('Obra creada.');
      renderControlHomeView(container);
    }
  });
}
