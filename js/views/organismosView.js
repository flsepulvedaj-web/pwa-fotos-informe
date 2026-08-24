import {
  getObra,
  updateObra,
  getOrganismosTramitesByObra,
  addOrganismoTramite,
  updateOrganismoTramite,
  deleteOrganismoTramite,
} from '../db.js';
import { openFolderPicker, isSignedIn } from '../googleDrive.js';
import { uploadOrganismoTramite, syncOrganismosFromDrive } from '../directorioSync.js';
import { navigate } from '../router.js';
import { escapeHTML, confirmDialog, toast } from '../utils.js';

function formatDateEs(iso) {
  if (!iso) return '—';
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * Estado de trámites ante organismos públicos (SEC, etc.): formulario +
 * listado, sin dashboard propio. Comparte la carpeta de Drive
 * ("directorioDriveFolderId") con Subcontratos.
 */
export async function renderOrganismosView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  let items = await getOrganismosTramitesByObra(obraId);
  let editingId = null;

  async function syncFromDrive({ auto }) {
    if (!obra.directorioDriveFolderId) return;
    if (auto && !isSignedIn()) return;
    try {
      const changed = await syncOrganismosFromDrive(obraId, obra.directorioDriveFolderId);
      items = await getOrganismosTramitesByObra(obraId);
      if (changed) {
        toast(`📥 ${changed} trámite(s) traído(s) de Drive.`);
        paint();
      } else if (!auto) {
        toast('Ya tenés todo lo más reciente.');
      }
    } catch (err) {
      console.error('Error sincronizando trámites desde Drive:', err);
      if (!auto) toast('No se pudo conectar con Drive.');
    }
  }

  function paint() {
    const editing = editingId ? items.find((t) => t.id === editingId) : null;

    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Organismos Públicos — ${escapeHTML(obra.name)}</span>
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
            <p class="avance-upload-hint">Vinculá una carpeta de Drive — esta misma se usa para Subcontratos de esta obra.</p>
          `}
        </section>

        <form class="ssma-form" id="org-form">
          <h2>${editingId ? 'Editar trámite' : 'Nuevo trámite'}</h2>

          <label for="o-item">Ítem</label>
          <input type="text" id="o-item" placeholder="Ej: 1" value="${escapeHTML(editing?.item || '')}" />

          <label for="o-gestion">Gestión</label>
          <input type="text" id="o-gestion" placeholder="Ej: Declaración instalación eléctrica (TE1)" value="${escapeHTML(editing?.gestion || '')}" />

          <label for="o-organismo">Organismo</label>
          <input type="text" id="o-organismo" placeholder="Ej: SEC" value="${escapeHTML(editing?.organismo || '')}" />

          <label class="rdi-checkbox-label">
            <input type="checkbox" id="o-aprobado" ${editing?.aprobado ? 'checked' : ''} />
            Aprobado
          </label>

          <label class="rdi-checkbox-label">
            <input type="checkbox" id="o-pago" ${editing?.pagoDerechos ? 'checked' : ''} />
            Pago de derechos hecho
          </label>

          <label class="rdi-checkbox-label">
            <input type="checkbox" id="o-designacion" ${editing?.designacionITO ? 'checked' : ''} />
            Designación de ITO hecha
          </label>

          <label for="o-fecha-est">Fecha estimada</label>
          <input type="date" id="o-fecha-est" value="${editing?.fechaEstimada || ''}" />

          <label for="o-fecha-ent">Fecha entregada</label>
          <input type="date" id="o-fecha-ent" value="${editing?.fechaEntregada || ''}" />

          <label for="o-obs">Observaciones</label>
          <textarea id="o-obs" maxlength="500">${escapeHTML(editing?.observaciones || '')}</textarea>

          <div class="ssma-form-actions">
            ${editingId ? '<button type="button" class="btn btn-secondary" id="o-cancel-edit">Cancelar edición</button>' : ''}
            <button type="submit" class="btn btn-primary">${editingId ? 'Guardar cambios' : 'Guardar'}</button>
          </div>
        </form>

        <h2 class="ssma-history-title">Listado</h2>
        ${items.length ? `
          <section class="ssma-history-list">
            ${items.map((t) => `
              <div class="ssma-history-row">
                <button type="button" class="ssma-history-main" data-edit-id="${t.id}">
                  <span class="ssma-history-date">${t.item ? `Ítem ${escapeHTML(t.item)} — ` : ''}${escapeHTML(t.organismo || '(sin organismo)')}</span>
                  <span class="ssma-history-count">${escapeHTML(t.gestion || '(sin descripción)')}</span>
                  <span class="ssma-history-split">${t.aprobado ? '✅ Aprobado' : '⏳ Sin aprobar'} · Pago: ${t.pagoDerechos ? 'Sí' : 'No'} · ITO: ${t.designacionITO ? 'Sí' : 'No'}${t.fechaEntregada ? ` · Entregado ${formatDateEs(t.fechaEntregada)}` : ''}</span>
                </button>
                <button type="button" class="icon-btn ssma-delete-btn" data-delete-id="${t.id}" title="Eliminar">🗑️</button>
              </div>
            `).join('')}
          </section>
        ` : `
          <div class="empty-state">
            <p>Todavía no hay trámites cargados.</p>
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

    const cancelBtn = container.querySelector('#o-cancel-edit');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { editingId = null; paint(); });

    container.querySelector('#org-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fields = {
        item: container.querySelector('#o-item').value.trim(),
        gestion: container.querySelector('#o-gestion').value.trim(),
        organismo: container.querySelector('#o-organismo').value.trim(),
        aprobado: container.querySelector('#o-aprobado').checked,
        pagoDerechos: container.querySelector('#o-pago').checked,
        designacionITO: container.querySelector('#o-designacion').checked,
        fechaEstimada: container.querySelector('#o-fecha-est').value || null,
        fechaEntregada: container.querySelector('#o-fecha-ent').value || null,
        observaciones: container.querySelector('#o-obs').value.trim(),
      };

      let saved;
      if (editingId) {
        saved = await updateOrganismoTramite(editingId, fields);
        toast('Trámite actualizado.');
        editingId = null;
      } else {
        saved = await addOrganismoTramite({ obraId, ...fields });
        toast('Trámite guardado.');
      }

      if (obra.directorioDriveFolderId) {
        const ok = await uploadOrganismoTramite(obra.directorioDriveFolderId, saved);
        if (!ok) toast('⚠️ No se pudo subir a Drive (quedó guardado en tu teléfono, se reintenta después).');
      }

      items = await getOrganismosTramitesByObra(obraId);
      paint();
    });

    container.querySelectorAll('.ssma-history-main').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingId = btn.dataset.editId;
        paint();
        container.querySelector('#org-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    container.querySelectorAll('.ssma-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('¿Eliminar este trámite? No se puede deshacer. Ojo: si estaba compartido con el equipo, la copia en Drive no se borra sola.');
        if (!ok) return;
        await deleteOrganismoTramite(btn.dataset.deleteId);
        if (editingId === btn.dataset.deleteId) editingId = null;
        items = await getOrganismosTramitesByObra(obraId);
        toast('Trámite eliminado.');
        paint();
      });
    });
  }

  paint();

  if (obra.directorioDriveFolderId) {
    syncFromDrive({ auto: true });
  }
}
