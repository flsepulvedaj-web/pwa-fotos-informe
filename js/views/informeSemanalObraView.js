import { getObra, getInformesSemanalesByObra, createInformeSemanal, deleteInformeSemanal } from '../db.js';
import { navigate } from '../router.js';
import { escapeHTML, confirmDialog, toast } from '../utils.js';

const STATUS_LABEL = { draft: 'Borrador', emitted: 'Emitido' };

function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateEs(iso) {
  if (!iso) return '—';
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * Lista de informes semanales de una obra (uno por reunión), con botón para
 * crear uno nuevo — mismo patrón que protocolObraView.js.
 */
export async function renderInformeSemanalObraView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  let informes = await getInformesSemanalesByObra(obraId);

  function paint() {
    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Informe Semanal — ${escapeHTML(obra.name)}</span>
      </header>
      <main class="view-content">
        ${informes.length ? `
          <section class="protocol-list">
            ${informes.map((i) => `
              <div class="protocol-tile-wrap">
                <button class="protocol-tile" data-informe-id="${i.id}">
                  <span class="protocol-tile-title">${formatDateEs(i.fecha)}${i.reunionTitulo ? ` — ${escapeHTML(i.reunionTitulo)}` : ''}</span>
                  <span class="protocol-tile-meta">
                    <span class="protocol-status protocol-status-${i.status}">${STATUS_LABEL[i.status]}</span>
                    ${i.lugar ? escapeHTML(i.lugar) : ''}
                  </span>
                </button>
                <button class="protocol-delete-btn" data-delete-informe-id="${i.id}" title="Eliminar informe">🗑️</button>
              </div>
            `).join('')}
          </section>
        ` : `
          <div class="empty-state">
            <p>Esta obra todavía no tiene informes semanales.</p>
            <p>Toca "Nuevo informe" para crear el de esta semana.</p>
          </div>
        `}
      </main>
      <div class="fab-row">
        <button class="fab fab-primary" id="btn-new-informe" title="Nuevo informe">📑➕</button>
      </div>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate(`/control/obra/${obraId}`));

    container.querySelectorAll('.protocol-tile').forEach((tile) => {
      tile.addEventListener('click', () => navigate(`/informe-semanal/instancia/${tile.dataset.informeId}`));
    });

    container.querySelectorAll('.protocol-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('¿Eliminar este informe semanal? Se borran también sus firmas. Esta acción no se puede deshacer.');
        if (!ok) return;
        await deleteInformeSemanal(btn.dataset.deleteInformeId);
        toast('Informe eliminado.');
        informes = await getInformesSemanalesByObra(obraId);
        paint();
      });
    });

    container.querySelector('#btn-new-informe').addEventListener('click', async () => {
      const informe = await createInformeSemanal({ obraId, fecha: todayLocalISO() });
      navigate(`/informe-semanal/instancia/${informe.id}`);
    });
  }

  paint();
}
