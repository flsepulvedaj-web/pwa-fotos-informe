import { getDraftInstances, getObra } from '../db.js';
import { navigate } from '../router.js';
import { escapeHTML, formatDate } from '../utils.js';

/**
 * Lista global de protocolos a medio llenar (todas las obras juntas — ver
 * decisión en el plan). Cada uno muestra a qué obra pertenece para no
 * perderse.
 */
export async function renderProtocolDraftsView(container) {
  const drafts = await getDraftInstances();
  const obras = await Promise.all(drafts.map((d) => getObra(d.obraId)));

  container.innerHTML = `
    <header class="app-header">
      <button class="icon-btn" id="btn-back" title="Volver">←</button>
      <span class="header-title">Protocolos en curso</span>
    </header>
    <main class="view-content">
      ${drafts.length ? `
        <section class="protocol-list">
          ${drafts.map((d, i) => `
            <button class="protocol-tile" data-instance-id="${d.id}">
              <span class="protocol-tile-title">${escapeHTML(d.templateTitle)}</span>
              <span class="protocol-tile-meta">${escapeHTML(obras[i]?.name || '—')} · ${formatDate(d.updatedAt)}</span>
            </button>
          `).join('')}
        </section>
      ` : `
        <div class="empty-state">
          <p>No hay protocolos a medio llenar.</p>
        </div>
      `}
    </main>
  `;

  container.querySelector('#btn-back').addEventListener('click', () => navigate('/protocolos'));
  container.querySelectorAll('.protocol-tile').forEach((tile) => {
    tile.addEventListener('click', () => navigate(`/protocolos/instancia/${tile.dataset.instanceId}`));
  });
}
