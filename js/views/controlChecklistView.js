import {
  getObra,
  updateObra,
  getChecklistTypesByObra,
  createChecklistType,
  updateChecklistType,
  getChecklistEntriesByType,
  getChecklistEntryByTypeAndDate,
  addChecklistEntry,
  updateChecklistEntry,
  deleteChecklistEntry,
  getChecklistPhotosByEntry,
  addChecklistPhoto,
  deleteChecklistPhoto,
} from '../db.js';
import { DEFAULT_CHECKLIST_TYPES, CHECKLIST_STATUS } from '../controlChecklistTemplates.js';
import { openFolderPicker, isSignedIn, getSignedInEmail } from '../googleDrive.js';
import { uploadChecklistEntry, syncChecklistFromDrive, uploadChecklistPhoto, syncChecklistPhotosFromDrive } from '../controlSync.js';
import { uploadObrasIndex } from '../obraSync.js';
import { isAdmin } from '../permissions.js';
import { driveLinkSectionHTML, wireDriveLinkSection } from '../driveLinkSection.js';
import { navigate, getQueryParams } from '../router.js';
import { escapeHTML, downscaleImageBlob, confirmDialog, toast, promptDialog } from '../utils.js';

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

let objectURLs = [];
function trackURL(url) {
  objectURLs.push(url);
  return url;
}
function revokeAllURLs() {
  objectURLs.forEach((u) => URL.revokeObjectURL(u));
  objectURLs = [];
}

/**
 * Checklist diario de obra — 3 listas (SSMA, Faenas Diarias, Programación),
 * mismo formato que el Excel real del equipo: ítems numerados, cada uno con
 * un estado (SI / No entregado / Incompleto / N-A / En revisión / No lo
 * tienen) + nota de qué hacer, más fotos del día. Los ítems de cada lista
 * son editables por obra (Faenas Diarias en particular cambia según la
 * etapa de la obra).
 */
export async function renderControlChecklistView(container, obraId) {
  revokeAllURLs();

  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  const admin = isAdmin(await getSignedInEmail());
  let types = await getChecklistTypesByObra(obraId);
  if (!types.length) {
    types = await Promise.all(DEFAULT_CHECKLIST_TYPES.map((t, i) => createChecklistType({ obraId, order: i, ...t })));
    types.sort((a, b) => a.order - b.order);
  }

  // Deep link desde el Dashboard ("Resolver" en un pendiente): abre
  // directo en el tipo/fecha/ítem exacto que falta revisar, en vez de
  // arrancar siempre en el tipo por defecto y el día de hoy.
  const deepLink = getQueryParams();
  const deepLinkType = types.find((t) => t.key === deepLink.get('type'));

  let activeTypeId = deepLinkType?.id || types[0].id;
  let entries = [];
  let entry = null;
  let photos = [];
  let editingItems = false;
  let highlightItemIndex = deepLink.has('item') ? Number(deepLink.get('item')) : null;

  function activeType() {
    return types.find((t) => t.id === activeTypeId);
  }

  async function loadType(typeId) {
    activeTypeId = typeId;
    editingItems = false;
    entries = await getChecklistEntriesByType(typeId);
    await loadEntryForDate(todayLocalISO());
  }

  async function loadEntryForDate(date) {
    const type = activeType();
    let e = await getChecklistEntryByTypeAndDate(type.id, date);
    if (!e) {
      e = await addChecklistEntry({ obraId, checklistTypeId: type.id, date, items: type.items });
      entries = await getChecklistEntriesByType(type.id);
    }
    entry = e;
    photos = await getChecklistPhotosByEntry(e.id);
  }

  entries = await getChecklistEntriesByType(activeTypeId);
  await loadEntryForDate(deepLink.get('date') || todayLocalISO());

  async function syncFromDrive({ auto }) {
    if (!obra.checklistDriveFolderId) return;
    // La sync automática nunca dispara el popup de sesión de Google.
    if (auto && !isSignedIn()) return;
    try {
      // Primero los checklists (JSON, livianos) y recién después las fotos:
      // syncChecklistPhotosFromDrive necesita que el checklist del día ya
      // exista localmente para poder engancharle la foto — si un día
      // llegara a faltar (poco probable, el JSON es rapidísimo), esa foto
      // queda para la próxima sincronización, no se pierde.
      const changed = await syncChecklistFromDrive(obraId, obra.checklistDriveFolderId);
      const newPhotos = await syncChecklistPhotosFromDrive(obraId, obra.checklistDriveFolderId);
      if (changed || newPhotos) {
        entries = await getChecklistEntriesByType(activeTypeId);
        await loadEntryForDate(entry.date);
        const parts = [];
        if (changed) parts.push(`${changed} checklist(s)`);
        if (newPhotos) parts.push(`${newPhotos} foto(s)`);
        toast(`📥 ${parts.join(' y ')} traído(s) de Drive.`);
        paint();
      } else if (!auto) {
        toast('Ya tenés todo lo más reciente.');
      }
    } catch (err) {
      console.error('Error sincronizando checklist desde Drive:', err);
      if (!auto) toast('No se pudo conectar con Drive.');
    }
  }

  function paint() {
    revokeAllURLs();
    const type = activeType();
    const sinContestarCount = entry.items.filter((it) => !it.status).length;

    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Checklist — ${escapeHTML(obra.name)}</span>
        <button class="icon-btn" id="btn-delete-entry" title="Eliminar checklist de este día">🗑️</button>
      </header>
      <main class="view-content protocol-form">
        ${driveLinkSectionHTML({
          admin,
          folderId: obra.checklistDriveFolderId,
          folderName: obra.checklistDriveFolderName,
          syncLabel: '🔄 Buscar checklist nuevo',
          hintText: 'Vinculá una carpeta de Drive para que el checklist que llene tu ITO en terreno te llegue a vos también.',
        })}

        <div class="checklist-type-tabs">
          ${types.map((t) => `
            <button type="button" class="checklist-type-tab ${t.id === activeTypeId ? 'active' : ''}" data-type-id="${t.id}">${escapeHTML(t.title)}</button>
          `).join('')}
        </div>

        <section class="protocol-form-fields">
          <label for="checklist-date">Fecha</label>
          <input type="date" id="checklist-date" value="${entry.date}" />
        </section>

        ${sinContestarCount ? `<div class="checklist-alert">⚠️ ${sinContestarCount} ítem(s) sin contestar</div>` : ''}

        <div class="checklist-edit-toggle">
          <button type="button" class="btn btn-secondary" id="btn-toggle-edit">${editingItems ? '✅ Listo' : '✏️ Editar ítems de esta lista'}</button>
        </div>

        ${editingItems ? `
          <section class="checklist-item-editor" id="checklist-item-editor">
            <p class="checklist-edit-hint">Estos cambios aplican a los días nuevos — el checklist de días ya creados (incluido hoy, si ya lo abriste) no cambia.</p>
            ${type.items.map((it, i) => `
              <div class="checklist-edit-row" data-item-index="${i}">
                <input type="text" class="checklist-edit-label" value="${escapeHTML(it.label)}" />
                <button type="button" class="icon-btn checklist-edit-delete" data-remove-index="${i}" title="Quitar ítem">🗑️</button>
              </div>
            `).join('')}
            <button type="button" class="btn btn-secondary" id="btn-add-item">➕ Agregar ítem</button>
          </section>
        ` : `
          <section class="control-point-list" id="control-point-list">
            ${entry.items.map((it, i) => renderChecklistItemRow(it, i, i === highlightItemIndex)).join('')}
          </section>

          <section class="protocol-photos">
            <h3>Fotografías del día</h3>
            <div class="protocol-photo-grid" id="checklist-photo-grid">
              ${photos.map((p) => `
                <div class="protocol-photo-item">
                  <img src="${trackURL(URL.createObjectURL(p.blob))}" alt="Foto" />
                  <button type="button" class="protocol-photo-delete" data-photo-id="${p.id}">✕</button>
                </div>
              `).join('')}
            </div>
            <button type="button" class="btn btn-secondary" id="btn-add-photos">📷 Agregar fotos</button>
            <input type="file" id="checklist-photo-input" accept="image/*" multiple hidden />
          </section>

          <h2 class="ssma-history-title">Días anteriores — ${escapeHTML(type.title)}</h2>
          ${entries.length ? `
            <section class="ssma-history-list">
              ${entries.map((e) => {
                const sinContestar = e.items.filter((it) => !it.status).length;
                const noCumple = e.items.filter((it) => it.status && it.status !== 'SI' && it.status !== 'N_A').length;
                return `
                  <button type="button" class="ssma-history-main" data-open-date="${e.date}">
                    <span class="ssma-history-date">${formatDateEs(e.date)}${e.date === entry.date ? ' (actual)' : ''}</span>
                    <span class="ssma-history-count">${sinContestar ? `⚠️ ${sinContestar} sin contestar` : '✅ Checklist completo'}</span>
                    ${noCumple ? `<span class="ssma-history-split">${noCumple} ítem(s) con "No cumple"</span>` : ''}
                  </button>
                `;
              }).join('')}
            </section>
          ` : ''}
        `}
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate(`/control/obra/${obraId}`));

    wireDriveLinkSection(container, {
      onLink: async () => {
        try {
          const picked = await openFolderPicker();
          if (!picked) return;
          await updateObra(obraId, { checklistDriveFolderId: picked.id, checklistDriveFolderName: picked.name });
          obra.checklistDriveFolderId = picked.id;
          obra.checklistDriveFolderName = picked.name;
          uploadObrasIndex(); // best-effort — le llega al resto del equipo sin esperar a que abran Control
          toast(`Carpeta vinculada: "${picked.name}".`);
          paint();
          syncFromDrive({ auto: false });
        } catch (err) {
          console.error(err);
          toast('No se pudo conectar con Google Drive.');
        }
      },
      onSync: () => syncFromDrive({ auto: false }),
    });

    container.querySelectorAll('.checklist-type-tab').forEach((tab) => {
      tab.addEventListener('click', async () => {
        if (tab.dataset.typeId === activeTypeId) return;
        await loadType(tab.dataset.typeId);
        paint();
      });
    });

    container.querySelector('#btn-delete-entry').addEventListener('click', async () => {
      const ok = await confirmDialog('¿Eliminar el checklist de este día? Se borran también sus fotos. No se puede deshacer.');
      if (!ok) return;
      await deleteChecklistEntry(entry.id);
      entries = await getChecklistEntriesByType(activeTypeId);
      await loadEntryForDate(todayLocalISO());
      toast('Checklist eliminado.');
      paint();
    });

    container.querySelector('#btn-toggle-edit').addEventListener('click', () => {
      editingItems = !editingItems;
      paint();
    });

    if (editingItems) {
      const editor = container.querySelector('#checklist-item-editor');

      editor.querySelectorAll('.checklist-edit-label').forEach((input, i) => {
        input.addEventListener('blur', async () => {
          const value = input.value.trim();
          if (!value) return;
          type.items[i].label = value;
          await updateChecklistType(type.id, { items: type.items });
        });
      });

      editor.querySelectorAll('.checklist-edit-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const idx = Number(btn.dataset.removeIndex);
          type.items.splice(idx, 1);
          await updateChecklistType(type.id, { items: type.items });
          paint();
        });
      });

      container.querySelector('#btn-add-item').addEventListener('click', async () => {
        const result = await promptDialog({
          title: 'Nuevo ítem',
          fields: [{ name: 'label', label: 'Descripción del ítem' }],
          confirmLabel: 'Agregar',
        });
        if (result && result.label) {
          type.items.push({ id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`, label: result.label, nota: '' });
          await updateChecklistType(type.id, { items: type.items });
          paint();
        }
      });

      return;
    }

    container.querySelector('#checklist-date').addEventListener('change', async (e) => {
      await loadEntryForDate(e.target.value);
      paint();
    });

    container.querySelector('#control-point-list').addEventListener('change', async (e) => {
      const select = e.target.closest('.checklist-status-select');
      if (!select) return;
      const row = select.closest('.control-point-row');
      const index = Number(row.dataset.index);
      entry.items[index].status = select.value || null;
      entry = await updateChecklistEntry(entry.id, { items: entry.items });
      if (obra.checklistDriveFolderId) {
        const ok = await uploadChecklistEntry(obra.checklistDriveFolderId, type.key, entry);
        if (!ok) toast('⚠️ No se pudo subir a Drive (quedó guardado en tu teléfono, se reintenta después).');
      }
    });

    // Observación: se guarda con un pequeño retraso mientras se escribe
    // (mismo patrón que las Observaciones de Protocolos), no letra por letra.
    let observacionTimer = null;
    container.querySelector('#control-point-list').addEventListener('input', (e) => {
      const input = e.target.closest('.checklist-observacion-input');
      if (!input) return;
      const row = input.closest('.control-point-row');
      const index = Number(row.dataset.index);
      const value = input.value;
      clearTimeout(observacionTimer);
      observacionTimer = setTimeout(async () => {
        entry.items[index].observacion = value;
        entry = await updateChecklistEntry(entry.id, { items: entry.items });
        if (obra.checklistDriveFolderId) {
          const ok = await uploadChecklistEntry(obra.checklistDriveFolderId, type.key, entry);
          if (!ok) toast('⚠️ No se pudo subir a Drive (quedó guardado en tu teléfono, se reintenta después).');
        }
      }, 500);
    });

    const photoInput = container.querySelector('#checklist-photo-input');
    container.querySelector('#btn-add-photos').addEventListener('click', () => photoInput.click());
    photoInput.addEventListener('change', async () => {
      const files = [...photoInput.files];
      photoInput.value = '';
      if (!files.length) return;
      let added = 0;
      for (const file of files) {
        try {
          const blob = await downscaleImageBlob(file);
          const photo = await addChecklistPhoto({ checklistId: entry.id, blob });
          if (obra.checklistDriveFolderId) {
            const ok = await uploadChecklistPhoto(obra.checklistDriveFolderId, type.title, entry.date, photo);
            if (!ok) toast('⚠️ Una foto no se pudo subir a Drive (quedó guardada en tu teléfono, se reintenta después).');
          }
          added++;
        } catch (err) {
          console.error('Error agregando foto al checklist:', err);
        }
      }
      if (added) {
        photos = await getChecklistPhotosByEntry(entry.id);
        paint();
      }
    });

    container.querySelector('#checklist-photo-grid').addEventListener('click', async (e) => {
      const btn = e.target.closest('.protocol-photo-delete');
      if (!btn) return;
      await deleteChecklistPhoto(btn.dataset.photoId);
      photos = await getChecklistPhotosByEntry(entry.id);
      paint();
    });

    container.querySelectorAll('[data-open-date]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await loadEntryForDate(btn.dataset.openDate);
        paint();
        container.querySelector('#control-point-list').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    // Si se llegó acá desde "Resolver" en el Dashboard, hace scroll al
    // ítem exacto una sola vez (no en cada repintado posterior).
    if (highlightItemIndex !== null) {
      const row = container.querySelector(`.control-point-row[data-index="${highlightItemIndex}"]`);
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      highlightItemIndex = null;
    }
  }

  paint();
}

function renderChecklistItemRow(item, index, highlighted) {
  return `
    <div class="control-point-row${highlighted ? ' control-point-highlighted' : ''}" data-index="${index}">
      <div class="control-point-label">${index + 1}. ${escapeHTML(item.label)}</div>
      ${item.nota ? `<div class="control-point-instruction">${escapeHTML(item.nota)}</div>` : ''}
      <select class="checklist-status-select">
        <option value="">— Elegir estado —</option>
        ${CHECKLIST_STATUS.map((s) => `<option value="${s.id}" ${item.status === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}
      </select>
      <input type="text" class="checklist-observacion-input" placeholder="Observación (opcional)" maxlength="300" value="${escapeHTML(item.observacion || '')}" />
    </div>
  `;
}
