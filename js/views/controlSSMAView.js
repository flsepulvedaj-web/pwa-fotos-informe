import {
  getObra,
  getSSMAEntriesByObra,
  getSSMAEntryByObraAndDate,
  addSSMAEntry,
  updateSSMAEntry,
  deleteSSMAEntry,
} from '../db.js';
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
 * SSMA: cuánta gente hay en obra cada día (propio + subcontrato). Un
 * formulario corto para hoy (o cualquier fecha atrasada que se les haya
 * quedado sin cargar) + la lista histórica debajo, editable.
 */
export async function renderControlSSMAView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  let entries = await getSSMAEntriesByObra(obraId);
  let editingId = null;

  function paint() {
    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Personal en obra — ${escapeHTML(obra.name)}</span>
      </header>
      <main class="view-content">
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

      if (editingId) {
        await updateSSMAEntry(editingId, { date, personalPropio, personalSubcontrato, nota });
        toast('Registro actualizado.');
        editingId = null;
      } else {
        // Si ya existe un registro para esa fecha, lo actualizamos en vez de
        // duplicarlo (por si Pancho carga dos veces el mismo día sin querer).
        const existing = await getSSMAEntryByObraAndDate(obraId, date);
        if (existing) {
          await updateSSMAEntry(existing.id, { personalPropio, personalSubcontrato, nota });
          toast(`Ya había un registro para el ${formatDateEs(date)} — se actualizó.`);
        } else {
          await addSSMAEntry({ obraId, date, personalPropio, personalSubcontrato, nota });
          toast('Registro guardado.');
        }
      }

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
        const ok = await confirmDialog('¿Eliminar este registro de personal? No se puede deshacer.');
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
}
