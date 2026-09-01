import { getAllObras, createObra } from '../db.js';
import { deleteObraEverywhere } from '../obraSync.js';
import { navigate } from '../router.js';
import { promptDialog, confirmDialog, toast, escapeHTML } from '../utils.js';
import {
  getSignedInEmail,
  getProtocolsRootFolder,
  setProtocolsRootFolder,
  clearProtocolsRootFolder,
  openFolderPicker,
} from '../googleDrive.js';
import { isAdmin, obrasForEmail, fetchPermissions, getCachedPermissions } from '../permissions.js';

/**
 * Pantalla de inicio del módulo Protocolos: lista de obras. Cada obra
 * agrupa sus propios protocolos (independiente del árbol de carpetas de
 * fotos del otro módulo).
 */
export async function renderProtocolHomeView(container) {
  const email = await getSignedInEmail();
  const isDriveAdmin = isAdmin(email);
  const allObras = await getAllObras();
  const allowedIds = obrasForEmail(email, getCachedPermissions(), allObras.map((o) => o.id));
  const obras = allObras.filter((o) => allowedIds.includes(o.id));

  // Refresca los permisos en segundo plano (por si Pancho te sacó/dio
  // acceso a una obra hace poco) — mismo patrón que homeView.js/Control.
  fetchPermissions().then((fresh) => {
    const freshIds = obrasForEmail(email, fresh, allObras.map((o) => o.id));
    if (JSON.stringify([...freshIds].sort()) !== JSON.stringify([...allowedIds].sort())) {
      renderProtocolHomeView(container);
    }
  }).catch((err) => console.error('Error refrescando permisos:', err));

  container.innerHTML = `
    <header class="app-header">
      <button class="icon-btn" id="btn-back-home" title="Volver al inicio">←</button>
      <span class="header-title">Protocolos</span>
      ${isDriveAdmin ? '<button class="icon-btn" id="btn-drive-settings" title="Configurar Google Drive">⚙️</button>' : ''}
      <button class="icon-btn" id="btn-drafts" title="Protocolos en curso">📝</button>
    </header>
    <main class="view-content">
      ${obras.length ? `
        <section class="obra-grid">
          ${obras.map((o) => `
            <div class="obra-tile-wrap">
              <button class="obra-tile" data-obra-id="${o.id}">
                <span class="obra-icon">🏗️</span>
                ${o.driveObraFolderId ? '<span class="obra-drive-badge" title="Enlazada con Google Drive">☁️</span>' : ''}
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

  container.querySelector('#btn-back-home').addEventListener('click', () => navigate('/proyectos'));
  container.querySelector('#btn-drafts').addEventListener('click', () => navigate('/protocolos/en-curso'));

  container.querySelectorAll('.obra-tile').forEach((tile) => {
    tile.addEventListener('click', () => navigate(`/protocolos/obra/${tile.dataset.obraId}`));
  });

  container.querySelectorAll('.obra-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog('¿Eliminar esta obra? Se borra TODO lo que tenga cargado en cualquier módulo (Protocolos, Control, Costos, RDI, Subcontratos, Organismos e Informe Semanal) — y le va a llegar también a los demás teléfonos del equipo la próxima vez que abran la app. No se puede deshacer.');
      if (!ok) return;
      toast('Eliminando…');
      await deleteObraEverywhere(btn.dataset.deleteObraId);
      toast('Obra eliminada — se va a propagar al resto del equipo.');
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

  const btnDriveSettings = container.querySelector('#btn-drive-settings');
  if (btnDriveSettings) {
    btnDriveSettings.addEventListener('click', async () => {
      const root = getProtocolsRootFolder();
      const action = await protocolsDriveSettingsSheet(root);
      if (action === 'change') {
        try {
          const picked = await openFolderPicker();
          if (picked) {
            setProtocolsRootFolder(picked);
            toast(`Carpeta raíz de Protocolos actualizada a "${picked.name}".`);
          }
        } catch (err) {
          console.error(err);
          toast('No se pudo conectar con Google Drive.');
        }
      } else if (action === 'clear') {
        clearProtocolsRootFolder();
        toast('Restricción quitada.');
      }
    });
  }
}

function protocolsDriveSettingsSheet(root) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal action-sheet" role="dialog" aria-modal="true">
        <h2>Google Drive — Protocolos</h2>
        <p class="modal-message">
          ${root
            ? `Las obras se vinculan dentro de <strong>"${escapeHTML(root.name)}"</strong>.`
            : 'Todavía no has elegido la carpeta raíz de Protocolos (la carpeta "PROTOCOLOS" que armaste en Drive). Sin esto, las obras no se pueden vincular a Drive.'}
        </p>
        <button class="sheet-action" data-action="change">📁 ${root ? 'Cambiar' : 'Elegir'} carpeta "PROTOCOLOS"</button>
        ${root ? '<button class="sheet-action sheet-danger" data-action="clear">🗑️ Quitar</button>' : ''}
        <button class="sheet-action" data-action="cancel">Cancelar</button>
      </div>
    `;
    document.body.appendChild(overlay);

    function cleanup(result) {
      overlay.remove();
      resolve(result);
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
      const btn = e.target.closest('[data-action]');
      if (btn) cleanup(btn.dataset.action === 'cancel' ? null : btn.dataset.action);
    });
  });
}
