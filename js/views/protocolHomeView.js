import { getAllObras, createObra, deleteObra } from '../db.js';
import { navigate } from '../router.js';
import { promptDialog, confirmDialog, toast, escapeHTML } from '../utils.js';

/**
 * Pantalla de inicio del módulo Protocolos: lista de obras. Cada obra
 * agrupa sus propios protocolos (independiente del árbol de carpetas de
 * fotos del otro módulo).
 */
export async function renderProtocolHomeView(container) {
  const obras = await getAllObras();

  container.innerHTML = `
    <header class="app-header">
      <button class="icon-btn" id="btn-back-home" title="Volver al inicio">←</button>
      <span class="header-title">Protocolos</span>
      <button class="icon-btn" id="btn-drafts" title="Protocolos en curso">📝</button>
    </header>
    <main class="view-content">
      ${obras.length ? `
        <section class="obra-grid">
          ${obras.map((o) => `
            <div class="obra-tile-wrap">
              <button class="obra-tile" data-obra-id="${o.id}">
                <span class="obra-icon">🏗️</span>
                <span class="obra-name">${escapeHTML(o.name)}</span>
              </button>
              <button class="obra-delete-btn" data-delete-obra-id="${o.id}" title="Eliminar obra">🗑️</button>
            </div>
          `).join('')}
        </section>
      ` : `
        <div class="empty-state">
          <p>Todavía no hay obras.</p>
          <p>Crea una para empezar a llenar protocolos.</p>
        </div>
      `}
    </main>
    <div class="fab-row">
      <button class="fab fab-primary" id="btn-new-obra" title="Nueva obra">🏗️➕</button>
    </div>
  `;

  container.querySelector('#btn-back-home').addEventListener('click', () => navigate('/'));
  container.querySelector('#btn-drafts').addEventListener('click', () => navigate('/protocolos/en-curso'));

  container.querySelectorAll('.obra-tile').forEach((tile) => {
    tile.addEventListener('click', () => navigate(`/protocolos/obra/${tile.dataset.obraId}`));
  });

  container.querySelectorAll('.obra-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog('¿Eliminar esta obra? Se borran también todos sus protocolos, fotos y firmas. Esta acción no se puede deshacer.');
      if (!ok) return;
      await deleteObra(btn.dataset.deleteObraId);
      toast('Obra eliminada.');
      renderProtocolHomeView(container);
    });
  });

  container.querySelector('#btn-new-obra').addEventListener('click', async () => {
    const result = await promptDialog({
      title: 'Nueva obra',
      fields: [{ name: 'name', label: 'Nombre de la obra', placeholder: 'Ej: Villa Los Aromos' }],
      confirmLabel: 'Crear',
    });
    if (result && result.name) {
      await createObra(result.name);
      renderProtocolHomeView(container);
    }
  });
}
