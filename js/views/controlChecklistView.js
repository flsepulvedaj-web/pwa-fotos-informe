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
  markChecklistPhotoUploaded,
} from '../db.js';
import { DEFAULT_CHECKLIST_TYPES, CHECKLIST_STATUS } from '../controlChecklistTemplates.js';
import { openFolderPicker, isSignedIn, getSignedInEmail } from '../googleDrive.js';
import { uploadChecklistEntry, syncChecklistFromDrive, uploadChecklistPhoto, syncChecklistPhotosFromDrive, uploadChecklistType, syncChecklistTypesFromDrive, uploadChecklistPDF } from '../controlSync.js';
import { buildChecklistPDF } from '../checklistPdfExport.js';
import { uploadObrasIndex } from '../obraSync.js';
import { isAdmin } from '../permissions.js';
import { driveLinkSectionHTML, wireDriveLinkSection } from '../driveLinkSection.js';
import { navigate, getQueryParams } from '../router.js';
import { escapeHTML, downscaleImageBlob, confirmDialog, toast, promptDialog, openPhotoLightbox } from '../utils.js';

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
    backfillUnuploadedEntries(activeType(), entries);
    await loadEntryForDate(todayLocalISO());
  }

  // Ids de fotos que YA se están subiendo en esta misma sesión de la
  // pantalla — sin esto, si `loadEntryForDate` se dispara 2 veces seguidas
  // para el mismo día (ej. cambiar de pestaña y volver rápido) antes de que
  // termine de marcarse la primera subida, backfillUnuploadedPhotos las ve
  // "pendientes" las 2 veces y las sube 2 veces (pasó de verdad: quedaron
  // duplicadas en Drive). Se marca ACÁ, antes de cualquier `await`, así la
  // segunda corrida la encuentra ya reclamada.
  const backfillClaimed = new Set();

  /** Fotos que se sacaron antes de que existiera la sincronización (o que
   * fallaron al subir en su momento) — nunca tuvieron `driveFileId`, así
   * que se suben ahora solas, en segundo plano, sin bloquear la pantalla.
   * Best-effort: si falla, se reintenta la próxima vez que se abra este día. */
  function backfillUnuploadedPhotos(type, date, entryId, photosList) {
    if (!obra.checklistDriveFolderId || !isSignedIn()) return;
    const pending = photosList.filter((p) => !p.driveFileId && !backfillClaimed.has(p.id));
    if (!pending.length) return;
    for (const photo of pending) backfillClaimed.add(photo.id);
    (async () => {
      for (const photo of pending) {
        try {
          const ok = await uploadChecklistPhoto(obra.checklistDriveFolderId, type.title, date, photo);
          if (ok) await markChecklistPhotoUploaded(photo.id, 'uploaded'); // el id real de Drive no hace falta acá — con marcarla alcanza para no reintentarla
        } catch (err) {
          console.error('No se pudo subir una foto vieja del checklist:', err);
        }
      }
    })();
  }

  // Ids de checklists (días) ya reclamados para el backfill en ESTA sesión
  // de la pantalla — mismo motivo que backfillClaimed (de fotos): evita
  // subir 2 veces el mismo día si esta función se dispara más de una vez
  // (ej. cambiar de pestaña y volver) antes de que se alcance a marcar
  // `driveSynced` en la base local.
  const entryBackfillClaimed = new Set();

  /** Autoreparación, de verdad UNA sola vez (no una vez por sesión): sube
   * los checklists locales de este tipo que nunca se marcaron
   * `driveSynced` — arregla días viejos que se crearon ANTES de que el
   * checklist se subiera apenas se crea (cuando solo se subía al contestar
   * el primer ítem), que por eso nunca llegaron a Drive — días donde solo
   * se sacaron fotos sin contestar nada quedaban invisibles para siempre en
   * los demás teléfonos, aunque las fotos sí estuvieran en Drive. Una vez
   * marcado `driveSynced`, no se vuelve a tocar ese día por este motivo
   * (evita seguir gastando cuota de Drive en re-subir lo que ya está bien). */
  function backfillUnuploadedEntries(type, entriesList) {
    if (!obra.checklistDriveFolderId || !isSignedIn()) return;
    const pending = entriesList.filter((e) => !e.driveSynced && !entryBackfillClaimed.has(e.id));
    if (!pending.length) return;
    for (const e of pending) entryBackfillClaimed.add(e.id);
    (async () => {
      for (const e of pending) {
        try {
          const ok = await uploadChecklistEntry(obra.checklistDriveFolderId, type.key, e);
          if (ok) await updateChecklistEntry(e.id, { driveSynced: true }, { updatedAt: e.updatedAt });
        } catch (err) {
          console.error('No se pudo resubir un checklist viejo a Drive:', err);
        }
      }
    })();
  }

  async function loadEntryForDate(date) {
    const type = activeType();
    let e = await getChecklistEntryByTypeAndDate(type.id, date);
    if (!e) {
      e = await addChecklistEntry({ obraId, checklistTypeId: type.id, date, items: type.items });
      entries = await getChecklistEntriesByType(type.id);
      // Se sube a Drive apenas se crea (antes solo se subía al contestar el
      // primer ítem) — si alguien abre un día y solo saca fotos sin
      // contestar nada, el checklist de ESE día nunca llegaba a Drive, y
      // sin el registro del día ahí, syncChecklistPhotosFromDrive no tenía
      // dónde "colgar" esas fotos en los demás teléfonos: quedaban para
      // siempre visibles solo en Drive, nunca dentro de la app de los
      // demás. Bug real detectado con Sergio en Loncoche.
      if (obra.checklistDriveFolderId) {
        uploadChecklistEntry(obra.checklistDriveFolderId, type.key, e)
          .then((ok) => { if (ok) updateChecklistEntry(e.id, { driveSynced: true }, { updatedAt: e.updatedAt }); })
          .catch((err) => console.error('No se pudo subir el checklist nuevo a Drive:', err));
      }
    }
    entry = e;
    photos = await getChecklistPhotosByEntry(e.id);
    backfillUnuploadedPhotos(type, date, e.id, photos);
  }

  entries = await getChecklistEntriesByType(activeTypeId);
  backfillUnuploadedEntries(activeType(), entries);
  await loadEntryForDate(deepLink.get('date') || todayLocalISO());

  async function syncFromDrive({ auto }) {
    if (!obra.checklistDriveFolderId) return;
    // La sync automática nunca dispara el popup de sesión de Google.
    if (auto && !isSignedIn()) return;
    try {
      // Primero la lista de preguntas (por si cambió algún texto), después
      // los checklists (JSON, livianos) y recién al final las fotos:
      // syncChecklistPhotosFromDrive necesita que el checklist del día ya
      // exista localmente para poder engancharle la foto — si un día
      // llegara a faltar (poco probable, el JSON es rapidísimo), esa foto
      // queda para la próxima sincronización, no se pierde.
      const typesChanged = await syncChecklistTypesFromDrive(obraId, obra.checklistDriveFolderId);
      if (typesChanged) types = await getChecklistTypesByObra(obraId);
      const changed = await syncChecklistFromDrive(obraId, obra.checklistDriveFolderId);
      const newPhotos = await syncChecklistPhotosFromDrive(obraId, obra.checklistDriveFolderId);
      if (typesChanged || changed || newPhotos) {
        entries = await getChecklistEntriesByType(activeTypeId);
        await loadEntryForDate(entry.date);
        const parts = [];
        if (typesChanged) parts.push(`${typesChanged} lista(s) de preguntas`);
        if (changed) parts.push(`${changed} checklist(s)`);
        if (newPhotos) parts.push(`${newPhotos} foto(s)`);
        toast(`📥 ${parts.join(', ')} traído(s) de Drive.`);
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
    // El texto (label/nota) sale SIEMPRE de la plantilla vigente del tipo,
    // no de lo que se guardó en el día — así editar una pregunta se ve al
    // toque en cualquier día (pasado, hoy o futuro), sin tener que borrar
    // nada. Lo único que se guarda por día son las RESPUESTAS (status/
    // observación), enganchadas por `itemId` — si se agrega una pregunta
    // nueva, los días viejos la muestran sin contestar (nunca la tuvieron);
    // si se borra una, simplemente deja de mostrarse (la respuesta vieja
    // queda guardada pero invisible, no se pierde por si se deshace).
    const mergedItems = mergeEntryItemsWithTemplate(type, entry);
    const sinContestarCount = mergedItems.filter((it) => !it.status).length;

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
            <p class="checklist-edit-hint">El cambio se ve al toque en cualquier día — pasado, hoy o futuro.</p>
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
            ${mergedItems.map((it, i) => renderChecklistItemRow(it, i, i === highlightItemIndex)).join('')}
          </section>

          <section class="protocol-photos">
            <h3>Fotografías del día</h3>
            <div class="protocol-photo-grid" id="checklist-photo-grid">
              ${photos.map((p) => `
                <div class="protocol-photo-item">
                  <img src="${trackURL(URL.createObjectURL(p.blob))}" alt="Foto" data-open-photo="${p.id}" />
                  <button type="button" class="protocol-photo-delete" data-photo-id="${p.id}">✕</button>
                </div>
              `).join('')}
            </div>
            <div class="ssma-form-actions">
              <button type="button" class="btn btn-secondary" id="btn-take-photo">📷 Tomar foto</button>
              <button type="button" class="btn btn-secondary" id="btn-add-photos">🖼️ Elegir de galería</button>
            </div>
            <input type="file" id="checklist-photo-input" accept="image/*" multiple hidden />
          </section>

          <h2 class="ssma-history-title">Días anteriores — ${escapeHTML(type.title)}</h2>
          ${entries.length ? `
            <section class="ssma-history-list">
              ${entries.map((e) => {
                // Mismo criterio "en vivo" que el día abierto (ver
                // mergeEntryItemsWithTemplate) — si no, un día viejo podía
                // seguir mostrando "✅ Checklist completo" en esta lista
                // aunque al abrirlo mostrara ítems nuevos sin contestar.
                const eItems = mergeEntryItemsWithTemplate(type, e);
                const sinContestar = eItems.filter((it) => !it.status).length;
                const noCumple = eItems.filter((it) => it.status && it.status !== 'SI' && it.status !== 'N_A').length;
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

      // Guarda local Y sube a Drive el texto de la lista — antes esto solo
      // se guardaba local: un cambio de texto se veía "perdido" apenas se
      // miraba desde otro teléfono o se limpiaba el caché.
      async function saveTypeItems() {
        const updated = await updateChecklistType(type.id, { items: type.items });
        if (obra.checklistDriveFolderId) {
          const ok = await uploadChecklistType(obra.checklistDriveFolderId, updated);
          if (!ok) toast('⚠️ El cambio de texto no se pudo subir a Drive (quedó guardado en tu teléfono, se reintenta después).');
        }
      }

      editor.querySelectorAll('.checklist-edit-label').forEach((input, i) => {
        input.addEventListener('blur', async () => {
          const value = input.value.trim();
          if (!value) return;
          type.items[i].label = value;
          await saveTypeItems();
        });
      });

      editor.querySelectorAll('.checklist-edit-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const idx = Number(btn.dataset.removeIndex);
          type.items.splice(idx, 1);
          await saveTypeItems();
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
          await saveTypeItems();
          paint();
        }
      });

      return;
    }

    container.querySelector('#checklist-date').addEventListener('change', async (e) => {
      await loadEntryForDate(e.target.value);
      paint();
    });

    // Busca/crea (por itemId, no por posición — la posición depende de la
    // plantilla vigente, que puede tener más o menos preguntas que las que
    // este día ya tenía guardadas) la respuesta de un ítem dentro de
    // entry.items, la modifica, y guarda+sube. `label`/`nota` NO se tocan
    // acá (si el registro es viejo los sigue teniendo, no hace nada — el
    // texto que se muestra siempre sale de la plantilla, ver
    // mergeEntryItemsWithTemplate).
    async function saveEntryItemAnswer(itemId, changes) {
      let stored = entry.items.find((it) => it.itemId === itemId);
      if (!stored) {
        stored = { itemId, label: '', nota: '', status: null, resolved: false, observacion: '' };
        entry.items.push(stored);
      }
      Object.assign(stored, changes);
      entry = await updateChecklistEntry(entry.id, { items: entry.items });
      if (obra.checklistDriveFolderId) {
        const ok = await uploadChecklistEntry(obra.checklistDriveFolderId, type.key, entry);
        if (!ok) toast('⚠️ No se pudo subir a Drive (quedó guardado en tu teléfono, se reintenta después).');
        else if (!entry.driveSynced) entry = await updateChecklistEntry(entry.id, { driveSynced: true }, { updatedAt: entry.updatedAt });
      }
      regenerateAndUploadPdf();
    }

    // Respaldo legible del checklist del día: se regenera y sube en segundo
    // plano cada vez que algo cambia (respuesta, observación o foto), para
    // que en Drive siempre quede un PDF (no el .json crudo) igual de
    // ordenado que las fotos. No bloquea la UI ni avisa si falla.
    async function regenerateAndUploadPdf() {
      if (!obra.checklistDriveFolderId) return;
      try {
        const currentPhotos = await getChecklistPhotosByEntry(entry.id);
        const blob = await buildChecklistPDF({
          obraName: obra.name,
          typeTitle: type.title,
          date: entry.date,
          items: mergeEntryItemsWithTemplate(type, entry),
          photos: currentPhotos,
        });
        await uploadChecklistPDF(obra.checklistDriveFolderId, type.title, entry.date, blob);
      } catch (err) {
        console.error('No se pudo generar/subir el PDF del checklist:', err);
      }
    }

    container.querySelector('#control-point-list').addEventListener('change', async (e) => {
      const select = e.target.closest('.checklist-status-select');
      if (!select) return;
      const row = select.closest('.control-point-row');
      await saveEntryItemAnswer(row.dataset.itemId, { status: select.value || null });
    });

    // Observación: se guarda con un pequeño retraso mientras se escribe
    // (mismo patrón que las Observaciones de Protocolos), no letra por letra.
    let observacionTimer = null;
    container.querySelector('#control-point-list').addEventListener('input', (e) => {
      const input = e.target.closest('.checklist-observacion-input');
      if (!input) return;
      const row = input.closest('.control-point-row');
      const itemId = row.dataset.itemId;
      const value = input.value;
      clearTimeout(observacionTimer);
      observacionTimer = setTimeout(() => saveEntryItemAnswer(itemId, { observacion: value }), 500);
    });

    async function handlePhotoFiles(files) {
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
        regenerateAndUploadPdf();
      }
    }

    const photoInput = container.querySelector('#checklist-photo-input');
    container.querySelector('#btn-add-photos').addEventListener('click', () => photoInput.click());
    photoInput.addEventListener('change', () => {
      const files = [...photoInput.files];
      photoInput.value = '';
      handlePhotoFiles(files);
    });

    container.querySelector('#btn-take-photo').addEventListener('click', () => {
      navigate(`/control/obra/${obraId}/checklist/camera?type=${type.key}&date=${entry.date}`);
    });

    container.querySelector('#checklist-photo-grid').addEventListener('click', async (e) => {
      const delBtn = e.target.closest('.protocol-photo-delete');
      if (delBtn) {
        await deleteChecklistPhoto(delBtn.dataset.photoId);
        photos = await getChecklistPhotosByEntry(entry.id);
        paint();
        regenerateAndUploadPdf();
        return;
      }
      const img = e.target.closest('[data-open-photo]');
      if (img) openPhotoLightbox(img.src);
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

/**
 * Junta, por `itemId`, el texto VIGENTE de la plantilla (label/nota — lo
 * que se está preguntando ahora) con la RESPUESTA guardada de ese día
 * (status/observacion/resolved) — así el texto se ve siempre actualizado,
 * incluso mirando un día viejo, sin tocar la respuesta que ya se guardó.
 * Recorre `type.items` (no `entry.items`) para que el orden y el set de
 * preguntas sea siempre el de la plantilla actual.
 */
/** Compara textos de pregunta para el respaldo por texto de abajo — tolera
 * mayúsculas/espacios de más, no exige coincidencia carácter por carácter. */
function sameLabel(a, b) {
  const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return !!a && !!b && norm(a) === norm(b);
}

function mergeEntryItemsWithTemplate(type, entry) {
  return type.items.map((templateItem) => {
    const itemId = templateItem.itemId ?? templateItem.id;
    // Primero por id — pero el id de una pregunta NO es 100% estable: cada
    // teléfono generaba sus propias preguntas por defecto la primera vez
    // que abría el checklist (antes de que existiera cualquier tipo en
    // Drive), así que dos teléfonos podían terminar con ids distintos para
    // "la misma" pregunta, y sincronizar el tipo desde Drive podía pisar
    // el set de ids local con el de otro teléfono — dejando respuestas ya
    // contestadas "sin contestar" para siempre en la pantalla, aunque el
    // dato real seguía ahí guardado. Bug real: Sergio en Loncoche tenía
    // días completos en Drive con "SI" en todo, pero a Pancho le salían
    // como pendientes. Por eso, si no hay match por id, se respalda
    // buscando por el TEXTO de la pregunta (que si no se editó, es el
    // mismo) antes de darla por no contestada.
    const stored = entry.items.find((it) => it.itemId === itemId) || entry.items.find((it) => sameLabel(it.label, templateItem.label));
    return {
      itemId,
      label: templateItem.label,
      nota: templateItem.nota || '',
      status: stored?.status ?? null,
      resolved: stored?.resolved ?? false,
      observacion: stored?.observacion || '',
    };
  });
}

function renderChecklistItemRow(item, index, highlighted) {
  return `
    <div class="control-point-row${highlighted ? ' control-point-highlighted' : ''}" data-index="${index}" data-item-id="${escapeHTML(String(item.itemId))}">
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
