import { getObra, getInstancesByObra, createProtocolInstance, deleteProtocolInstance } from '../db.js';
import { PROTOCOL_TEMPLATES } from '../protocolTemplates.js';
import { navigate } from '../router.js';
import { escapeHTML, formatDate, confirmDialog, toast } from '../utils.js';

const STATUS_LABEL = { draft: 'Borrador', emitted: 'Emitido' };

/**
 * Detalle de una obra: sus protocolos (borradores y emitidos) + botón para
 * empezar uno nuevo eligiendo una de las 100 plantillas.
 */
export async function renderProtocolObraView(container, obraId) {
  const [obra, instances] = await Promise.all([getObra(obraId), getInstancesByObra(obraId)]);
  if (!obra) {
    navigate('/protocolos');
    return;
  }

  container.innerHTML = `
    <header class="app-header">
      <button class="icon-btn" id="btn-back" title="Volver">←</button>
      <span class="header-title">${escapeHTML(obra.name)}</span>
    </header>
    <main class="view-content">
      ${instances.length ? `
        <section class="protocol-list">
          ${instances.map((i) => `
            <div class="protocol-tile-wrap">
              <button class="protocol-tile" data-instance-id="${i.id}">
                <span class="protocol-tile-title">${escapeHTML(i.templateTitle)}</span>
                <span class="protocol-tile-meta">
                  <span class="protocol-status protocol-status-${i.status}">${STATUS_LABEL[i.status]}</span>
                  ${formatDate(i.updatedAt)}
                </span>
              </button>
              <button class="protocol-delete-btn" data-delete-instance-id="${i.id}" title="Eliminar protocolo">🗑️</button>
            </div>
          `).join('')}
        </section>
      ` : `
        <div class="empty-state">
          <p>Esta obra todavía no tiene protocolos.</p>
          <p>Toca "Nuevo protocolo" para elegir uno de la lista.</p>
        </div>
      `}
    </main>
    <div class="fab-row">
      <button class="fab fab-primary" id="btn-new-protocol" title="Nuevo protocolo">📋➕</button>
    </div>
  `;

  container.querySelector('#btn-back').addEventListener('click', () => navigate('/protocolos'));

  container.querySelectorAll('.protocol-tile').forEach((tile) => {
    tile.addEventListener('click', () => navigate(`/protocolos/instancia/${tile.dataset.instanceId}`));
  });

  container.querySelectorAll('.protocol-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog('¿Eliminar este protocolo? Se borran también sus fotos y firmas. Esta acción no se puede deshacer.');
      if (!ok) return;
      await deleteProtocolInstance(btn.dataset.deleteInstanceId);
      toast('Protocolo eliminado.');
      renderProtocolObraView(container, obraId);
    });
  });

  container.querySelector('#btn-new-protocol').addEventListener('click', async () => {
    const templateId = await templatePickerDialog();
    if (!templateId) return;
    const template = PROTOCOL_TEMPLATES.find((t) => t.id === templateId);
    if (!template) return;
    const instance = await createProtocolInstance({
      obraId,
      templateId: template.id,
      templateTitle: template.title,
      header: { obra: obra.name },
      controlPoints: template.controlPoints,
    });
    navigate(`/protocolos/instancia/${instance.id}`);
  });
}

/** Lista buscable de los 100 protocolos. Devuelve el id elegido o null. */
function templatePickerDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal template-picker" role="dialog" aria-modal="true">
        <h2>Elegir protocolo</h2>
        <input type="text" id="template-search" class="template-search" placeholder="Buscar…" autocomplete="off" />
        <div class="folder-picker-list" id="template-list">
          ${PROTOCOL_TEMPLATES.map((t) => `
            <button class="folder-picker-item" data-template-id="${t.id}" data-search="${escapeHTML(t.title.toLowerCase())}">
              ${escapeHTML(t.number)} — ${escapeHTML(t.title)}
            </button>
          `).join('')}
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-action="cancel">Cancelar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const searchInput = overlay.querySelector('#template-search');
    const items = [...overlay.querySelectorAll('.folder-picker-item')];
    searchInput.focus();
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      items.forEach((item) => {
        item.hidden = q !== '' && !item.dataset.search.includes(q);
      });
    });

    function cleanup(result) {
      overlay.remove();
      resolve(result);
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
      if (e.target.closest('[data-action="cancel"]')) cleanup(null);
      const item = e.target.closest('.folder-picker-item');
      if (item) cleanup(item.dataset.templateId);
    });
  });
}
