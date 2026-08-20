import {
  getObra,
  updateObra,
  getSSMAEntriesByObra,
  getSSMAEntryByObraAndDate,
  addSSMAEntry,
  updateSSMAEntry,
  deleteSSMAEntry,
} from '../db.js';
import { openFolderPicker, isSignedIn } from '../googleDrive.js';
import { uploadSSMAEntry, syncSSMAFromDrive } from '../controlSync.js';
import { navigate } from '../router.js';
import { escapeHTML, confirmDialog, toast } from '../utils.js';

function todayLocalISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatDateEs(iso) {
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * Personal en obra: cuánta gente hay cada día (propio + subcontrato). Un
 * formulario corto para hoy (o cualquier fecha atrasada) + el historial
 * debajo, editable. Si hay una carpeta de Drive vinculada, cada guardado se
 * sube ahí y cada apertura trae lo que haya cargado el resto del equipo
 * (ej. Sergio desde su teléfono) — mismo mecanismo que Avance programado.
 */
export async function renderControlSSMAView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  let entries = await getSSMAEntriesByObra(obraId);
  let editingId = null;

  async function syncFromDrive({ auto }) {
    if (!obra.personalDriveFolderId) return;
    // Igual que en Avance: la sync automática nunca debe disparar el popup
    // de sesión de Google — se salta calladita si el token ya venció.
    if (auto && !isSignedIn()) return;
    try {
      const changed = await syncSSMAFromDrive(obraId, obra.personalDriveFolderId);
      entries = await getSSMAEntriesByObra(obraId);
      if (changed) {
        toast(`📥 ${changed} registro(s) de personal traídos de Drive.`);
        paint();
      } else if (!auto) {
        toast('Ya tenés todo lo más reciente.');
      }
    } catch (err) {
      console.error('Error sincronizando personal desde Drive:', err);
      if (!auto) toast('No se pudo conectar con Drive.');
    }
  }

  function paint() {
    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Personal en obra — ${escapeHTML(obra.name)}</span>
      </header>
      <main class="view-content">
        <section class="avance-drive-link">
          ${obra.personalDriveFolderId ? `
            <div class="avance-drive-linked">☁️ Compartido con el equipo en: <strong>${escapeHTML(obra.personalDriveFolderName)}</strong></div>
            <div class="avance-drive-actions">
              <button type="button" class="btn btn-secondary" id="btn-check-drive">🔄 Buscar registros nuevos</button>
              <button type="button" class="btn btn-secondary" id="btn-change-drive-folder">Cambiar carpeta</button>
            </div>
          ` : `
            <button type="button" class="btn btn-primary" id="btn-link-drive-folder">🔗 Compartir con el equipo (Drive)</button>
            <p class="avance-upload-hint">Vinculá una carpeta de Drive para que lo que cargue cualquiera del equipo (ej. tu ITO en terreno) te llegue a vos también.</p>
          `}
        </section>

        <form class="ssma-form" id="ssma-form">
          <h2>${editingId ? 'Editar registro' : 'Registrar personal de hoy'}</h2>
          <label for="ssma-date">Fecha</label>
          <input type="date" id="ssma-date" required />

          <label for="ssma-propio">Personal propio</label>
          <input type="number" id="ssma-propio" min="0" step="1" inputmode="numeric" required />

          <label for="ssma-sub">Personal subcontrato</label>
          <input type="number" id="ssma-sub" min="0" step="1" inputmode="numeric" required />

          <label for="ssma-nota">Nota (opcional)</label>
          <textarea id="ssma-nota" maxlength="300" placeholder="Ej: lluvia en la tarde, se retiró personal a las 15:00"></textarea>

          <div class="ssma-form-actions">
            ${editingId ? '<button type="button" class="btn btn-secondary" id="ssma-cancel-edit">Cancelar edición</button>' : ''}
            <button type="submit" class="btn btn-primary">${editingId ? 'Guardar cambios' : 'Guardar'}</button>
          </div>
        </form>

        <h2 class="ssma-history-title">Historial</h2>
        ${entries.length ? `
          <section class="ssma-history-list">
            ${entries.map((e) => `
              <div class="ssma-history-row">
                <button type="button" class="ssma-history-main" data-edit-id="${e.id}">
                  <span class="ssma-history-date">${formatDateEs(e.date)}</span>
                  <span class="ssma-history-count">👷 ${e.personalPropio + e.personalSubcontrato} en obra</span>
                  <span class="ssma-history-split">(${e.personalPropio} propio + ${e.personalSubcontrato} subcontrato)</span>
                  ${e.nota ? `<span class="ssma-history-nota">${escapeHTML(e.nota)}</span>` : ''}
                </button>
                <button type="button" class="icon-btn ssma-delete-btn" data-delete-id="${e.id}" title="Eliminar registro">🗑️</button>
              </div>
            `).join('')}
          </section>
        ` : `
          <div class="empty-state">
            <p>Todavía no hay registros de personal.</p>
          </div>
        `}
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate(`/control/obra/${obraId}`));

    const linkFolder = async () => {
      try {
        const picked = await openFolderPicker();
        if (!picked) return;
        await updateObra(obraId, { personalDriveFolderId: picked.id, personalDriveFolderName: picked.name });
        obra.personalDriveFolderId = picked.id;
        obra.personalDriveFolderName = picked.name;
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

    const dateInput = container.querySelector('#ssma-date');
    const propioInput = container.querySelector('#ssma-propio');
    const subInput = container.querySelector('#ssma-sub');
    const notaInput = container.querySelector('#ssma-nota');

    if (editingId) {
      const entry = entries.find((e) => e.id === editingId);
      dateInput.value = entry.date;
      propioInput.value = entry.personalPropio;
      subInput.value = entry.personalSubcontrato;
      notaInput.value = entry.nota || '';
    } else {
      dateInput.value = todayLocalISO();
      propioInput.value = '';
      subInput.value = '';
      notaInput.value = '';
    }

    const cancelBtn = container.querySelector('#ssma-cancel-edit');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        editingId = null;
        paint();
      });
    }

    container.querySelector('#ssma-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const date = dateInput.value;
      const personalPropio = Math.max(0, parseInt(propioInput.value, 10) || 0);
      const personalSubcontrato = Math.max(0, parseInt(subInput.value, 10) || 0);
      const nota = notaInput.value.trim();

      if (!date) {
        toast('Elegí una fecha.');
        return;
      }

      let saved;
      if (editingId) {
        saved = await updateSSMAEntry(editingId, { date, personalPropio, personalSubcontrato, nota });
        toast('Registro actualizado.');
        editingId = null;
      } else {
        // Si ya existe un registro para esa fecha, lo actualizamos en vez de
        // duplicarlo (por si Pancho carga dos veces el mismo día sin querer).
        const existing = await getSSMAEntryByObraAndDate(obraId, date);
        if (existing) {
          saved = await updateSSMAEntry(existing.id, { personalPropio, personalSubcontrato, nota });
          toast(`Ya había un registro para el ${formatDateEs(date)} — se actualizó.`);
        } else {
          saved = await addSSMAEntry({ obraId, date, personalPropio, personalSubcontrato, nota });
          toast('Registro guardado.');
        }
      }

      if (obra.personalDriveFolderId) uploadSSMAEntry(obra.personalDriveFolderId, saved);

      entries = await getSSMAEntriesByObra(obraId);
      paint();
    });

    container.querySelectorAll('.ssma-history-main').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingId = btn.dataset.editId;
        paint();
        container.querySelector('#ssma-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    container.querySelectorAll('.ssma-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('¿Eliminar este registro de personal? No se puede deshacer. Ojo: si estaba compartido con el equipo, la copia en Drive no se borra sola.');
        if (!ok) return;
        await deleteSSMAEntry(btn.dataset.deleteId);
        if (editingId === btn.dataset.deleteId) editingId = null;
        entries = await getSSMAEntriesByObra(obraId);
        toast('Registro eliminado.');
        paint();
      });
    });
  }

  paint();

  if (obra.personalDriveFolderId) {
    syncFromDrive({ auto: true });
  }
}
