import {
  getObra,
  updateObra,
  getSubcontratosByObra,
  addSubcontrato,
  updateSubcontrato,
  deleteSubcontrato,
} from '../db.js';
import { openFolderPicker, isSignedIn } from '../googleDrive.js';
import { uploadSubcontrato, syncSubcontratosFromDrive } from '../directorioSync.js';
import { navigate } from '../router.js';
import { escapeHTML, confirmDialog, toast } from '../utils.js';

/**
 * Directorio de subcontratos: formulario + historial, sin dashboard propio
 * (es una lista de contactos, no un KPI). Comparte la carpeta de Drive
 * ("directorioDriveFolderId") con Organismos Públicos.
 */
export async function renderSubcontratosView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  let items = await getSubcontratosByObra(obraId);
  let editingId = null;

  async function syncFromDrive({ auto }) {
    if (!obra.directorioDriveFolderId) return;
    if (auto && !isSignedIn()) return;
    try {
      const changed = await syncSubcontratosFromDrive(obraId, obra.directorioDriveFolderId);
      items = await getSubcontratosByObra(obraId);
      if (changed) {
        toast(`📥 ${changed} subcontrato(s) traído(s) de Drive.`);
        paint();
      } else if (!auto) {
        toast('Ya tenés todo lo más reciente.');
      }
    } catch (err) {
      console.error('Error sincronizando subcontratos desde Drive:', err);
      if (!auto) toast('No se pudo conectar con Drive.');
    }
  }

  function paint() {
    const editing = editingId ? items.find((s) => s.id === editingId) : null;

    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Subcontratos — ${escapeHTML(obra.name)}</span>
      </header>
      <main class="view-content">
        <section class="avance-drive-link">
          ${obra.directorioDriveFolderId ? `
            <div class="avance-drive-linked">☁️ Compartido en: <strong>${escapeHTML(obra.directorioDriveFolderName)}</strong></div>
            <div class="avance-drive-actions">
              <button type="button" class="btn btn-secondary" id="btn-check-drive">🔄 Buscar cambios</button>
              <button type="button" class="btn btn-secondary" id="btn-change-drive-folder">Cambiar carpeta</button>
            </div>
          ` : `
            <button type="button" class="btn btn-primary" id="btn-link-drive-folder">🔗 Compartir con el equipo (Drive)</button>
            <p class="avance-upload-hint">Vinculá una carpeta de Drive — esta misma se usa para Organismos Públicos de esta obra.</p>
          `}
        </section>

        <form class="ssma-form" id="sub-form">
          <h2>${editingId ? 'Editar subcontrato' : 'Nuevo subcontrato'}</h2>

          <label for="s-numero">N°</label>
          <input type="text" id="s-numero" value="${escapeHTML(editing?.numero || '')}" />

          <label for="s-razon">Subcontrato / Razón social</label>
          <input type="text" id="s-razon" placeholder="Ej: M y M Ltda" value="${escapeHTML(editing?.razonSocial || '')}" />

          <label for="s-servicio">Servicio</label>
          <input type="text" id="s-servicio" placeholder="Ej: Piping" value="${escapeHTML(editing?.servicio || '')}" />

          <label for="s-rut">RUT</label>
          <input type="text" id="s-rut" value="${escapeHTML(editing?.rut || '')}" />

          <label for="s-contacto">Contacto</label>
          <input type="text" id="s-contacto" value="${escapeHTML(editing?.contacto || '')}" />

          <label for="s-fono">Fono</label>
          <input type="tel" id="s-fono" value="${escapeHTML(editing?.fono || '')}" />

          <label for="s-email">E-mail</label>
          <input type="email" id="s-email" value="${escapeHTML(editing?.email || '')}" />

          <label class="rdi-checkbox-label">
            <input type="checkbox" id="s-activo" ${editing ? (editing.activo ? 'checked' : '') : 'checked'} />
            Activo en la obra
          </label>

          <div class="ssma-form-actions">
            ${editingId ? '<button type="button" class="btn btn-secondary" id="s-cancel-edit">Cancelar edición</button>' : ''}
            <button type="submit" class="btn btn-primary">${editingId ? 'Guardar cambios' : 'Guardar'}</button>
          </div>
        </form>

        <h2 class="ssma-history-title">Listado</h2>
        ${items.length ? `
          <section class="ssma-history-list">
            ${items.map((s) => `
              <div class="ssma-history-row">
                <button type="button" class="ssma-history-main" data-edit-id="${s.id}">
                  <span class="ssma-history-date">${s.numero ? `N° ${escapeHTML(s.numero)} — ` : ''}${escapeHTML(s.razonSocial || '(sin nombre)')}${s.activo ? '' : ' (inactivo)'}</span>
                  <span class="ssma-history-count">${escapeHTML(s.servicio || '(sin servicio)')}</span>
                  <span class="ssma-history-split">${escapeHTML(s.contacto || '—')}${s.fono ? ` · ${escapeHTML(s.fono)}` : ''}${s.email ? ` · ${escapeHTML(s.email)}` : ''}</span>
                </button>
                <button type="button" class="icon-btn ssma-delete-btn" data-delete-id="${s.id}" title="Eliminar">🗑️</button>
              </div>
            `).join('')}
          </section>
        ` : `
          <div class="empty-state">
            <p>Todavía no hay subcontratos cargados.</p>
          </div>
        `}
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate(`/control/obra/${obraId}`));

    const linkFolder = async () => {
      try {
        const picked = await openFolderPicker();
        if (!picked) return;
        await updateObra(obraId, { directorioDriveFolderId: picked.id, directorioDriveFolderName: picked.name });
        obra.directorioDriveFolderId = picked.id;
        obra.directorioDriveFolderName = picked.name;
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

    const cancelBtn = container.querySelector('#s-cancel-edit');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { editingId = null; paint(); });

    container.querySelector('#sub-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fields = {
        numero: container.querySelector('#s-numero').value.trim(),
        razonSocial: container.querySelector('#s-razon').value.trim(),
        servicio: container.querySelector('#s-servicio').value.trim(),
        rut: container.querySelector('#s-rut').value.trim(),
        contacto: container.querySelector('#s-contacto').value.trim(),
        fono: container.querySelector('#s-fono').value.trim(),
        email: container.querySelector('#s-email').value.trim(),
        activo: container.querySelector('#s-activo').checked,
      };

      let saved;
      if (editingId) {
        saved = await updateSubcontrato(editingId, fields);
        toast('Subcontrato actualizado.');
        editingId = null;
      } else {
        saved = await addSubcontrato({ obraId, ...fields });
        toast('Subcontrato guardado.');
      }

      if (obra.directorioDriveFolderId) {
        const ok = await uploadSubcontrato(obra.directorioDriveFolderId, saved);
        if (!ok) toast('⚠️ No se pudo subir a Drive (quedó guardado en tu teléfono, se reintenta después).');
      }

      items = await getSubcontratosByObra(obraId);
      paint();
    });

    container.querySelectorAll('.ssma-history-main').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingId = btn.dataset.editId;
        paint();
        container.querySelector('#sub-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    container.querySelectorAll('.ssma-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('¿Eliminar este subcontrato? No se puede deshacer. Ojo: si estaba compartido con el equipo, la copia en Drive no se borra sola.');
        if (!ok) return;
        await deleteSubcontrato(btn.dataset.deleteId);
        if (editingId === btn.dataset.deleteId) editingId = null;
        items = await getSubcontratosByObra(obraId);
        toast('Subcontrato eliminado.');
        paint();
      });
    });
  }

  paint();

  if (obra.directorioDriveFolderId) {
    syncFromDrive({ auto: true });
  }
}
