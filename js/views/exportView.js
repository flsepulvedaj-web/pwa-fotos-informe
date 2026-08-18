import { buildObraReportPDF, downloadBlob, sanitizeFilename } from '../pdfExport.js';
import { updatePhoto, updateFolder, getPhotosByFolder } from '../db.js';
import { escapeHTML, toast } from '../utils.js';
import { REPORT_FORMATS, getFormatById, fixedLabelFor } from '../reportFormats.js';

const LAST_FORMAT_KEY = 'export-last-format';

function defaultPeriod() {
  try {
    const label = new Date().toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    return '';
  }
}

/**
 * Mini galería para elegir un reemplazo de una foto en la pantalla de
 * revisión — muestra las demás fotos de la misma carpeta de origen
 * (candidatos ya viene filtrado: sin la foto actual ni las que ya están
 * usadas en otra fila). Devuelve el id elegido, o null si se cancela.
 */
function photoSwapSheet(candidates, urlByPhotoId) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal photo-swap-sheet" role="dialog" aria-modal="true">
        <h2>Elegir otra foto</h2>
        <div class="photo-swap-grid">
          ${candidates
            .map(
              (p) => `
                <button type="button" class="photo-swap-item" data-photo-id="${p.id}">
                  <img src="${urlByPhotoId.get(p.id)}" alt="" loading="lazy" />
                </button>
              `
            )
            .join('')}
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-action="cancel">Cancelar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    function cleanup(result) {
      overlay.remove();
      resolve(result);
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
      if (e.target.closest('[data-action="cancel"]')) cleanup(null);
      const item = e.target.closest('.photo-swap-item');
      if (item) cleanup(item.dataset.photoId);
    });
  });
}

/**
 * Pantalla completa previa a exportar: encabezado del informe (obra, N°,
 * período, formato) + lista reordenable de fotos, cada una con su
 * descripción ("Imagen N:") — libre para escribir, o de solo lectura si el
 * formato elegido trae un texto fijo para esa posición. Al confirmar,
 * guarda las descripciones libres en cada foto y el N°/período en la
 * carpeta (para precargarlos la próxima vez), arma el PDF con el formato
 * elegido en el orden final y lo descarga. Devuelve true si se exportó,
 * false si se canceló.
 */
export function openExportReviewScreen(photos, folder) {
  return new Promise((resolve) => {
    const objectURLs = new Map();
    for (const p of photos) objectURLs.set(p.id, URL.createObjectURL(p.blob));

    const orderedPhotos = [...photos];
    const captionDrafts = new Map(photos.map((p) => [p.id, p.title || '']));
    let format = getFormatById(localStorage.getItem(LAST_FORMAT_KEY) || 'libre');

    const overlay = document.createElement('div');
    overlay.className = 'export-review';

    overlay.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="er-close" title="Cancelar">✕</button>
        <span class="header-title">Exportar informe</span>
        <button class="btn btn-primary" id="er-confirm">Exportar</button>
      </header>
      <div class="export-review-content">
        <div class="er-header-form">
          <label for="er-obra">Obra</label>
          <input id="er-obra" type="text" value="${escapeHTML(folder.name)}" />
          <div class="er-row">
            <div class="er-field">
              <label for="er-report-number">N° de informe</label>
              <input id="er-report-number" type="text" value="${escapeHTML(folder.reportNumber || '')}" placeholder="Ej: 5" />
            </div>
            <div class="er-field">
              <label for="er-period">Período</label>
              <input id="er-period" type="text" value="${escapeHTML(folder.reportPeriod || defaultPeriod())}" placeholder="Ej: Julio 2026" />
            </div>
          </div>
          <label for="er-format">Formato del informe</label>
          <select id="er-format">
            ${REPORT_FORMATS.map((f) => `<option value="${f.id}" ${f.id === format.id ? 'selected' : ''}>${escapeHTML(f.label)}</option>`).join('')}
          </select>
          ${orderedPhotos.length > 1 ? '<p class="er-hint">Si el formato trae casilleros fijos (ej. "Casa con más avance"), usa las flechas para ordenar las fotos en la posición correcta — no hace falta escribirles nada.</p>' : ''}
        </div>
        <div class="er-photo-list" id="er-photo-list"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const list = overlay.querySelector('#er-photo-list');
    const formatSelect = overlay.querySelector('#er-format');

    function renderList() {
      list.innerHTML = orderedPhotos
        .map((p, i) => {
          const slotIndex = i % 8;
          const fixed = fixedLabelFor(format, slotIndex);
          const url = objectURLs.get(p.id);
          return `
            <div class="er-photo-row">
              <div class="er-reorder">
                <button type="button" class="er-move-btn" data-dir="up" data-index="${i}" ${i === 0 ? 'disabled' : ''} title="Subir">▲</button>
                <button type="button" class="er-move-btn" data-dir="down" data-index="${i}" ${i === orderedPhotos.length - 1 ? 'disabled' : ''} title="Bajar">▼</button>
                <button type="button" class="er-swap-btn" data-index="${i}" title="Cambiar esta foto">🔄</button>
              </div>
              <img src="${url}" alt="Imagen ${i + 1}" loading="lazy" />
              <div class="er-photo-fields">
                <span class="er-photo-label">Imagen ${i + 1}</span>
                ${fixed
                  ? `<div class="er-fixed-caption">${escapeHTML(fixed)} <span class="er-fixed-tag">fijo</span></div>`
                  : `<input class="er-caption-input" type="text" data-photo-id="${p.id}" value="${escapeHTML(captionDrafts.get(p.id) || '')}" placeholder="Descripción para el informe" />`
                }
              </div>
            </div>
          `;
        })
        .join('');
    }

    renderList();

    list.addEventListener('input', (e) => {
      if (e.target.classList.contains('er-caption-input')) {
        captionDrafts.set(e.target.dataset.photoId, e.target.value);
      }
    });

    list.addEventListener('click', (e) => {
      const btn = e.target.closest('.er-move-btn');
      if (!btn || btn.disabled) return;
      const idx = Number(btn.dataset.index);
      const swapWith = btn.dataset.dir === 'up' ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= orderedPhotos.length) return;
      [orderedPhotos[idx], orderedPhotos[swapWith]] = [orderedPhotos[swapWith], orderedPhotos[idx]];
      renderList();
    });

    // "🔄 Cambiar esta foto": ofrece las demás fotos de la MISMA carpeta de
    // origen de esa foto (photo.folderId, que toda foto real ya trae) —
    // así Pancho puede reemplazar una que no le gustó sin tener que
    // cancelar y rehacer toda la selección de nuevo.
    list.addEventListener('click', async (e) => {
      const swapBtn = e.target.closest('.er-swap-btn');
      if (!swapBtn) return;
      const idx = Number(swapBtn.dataset.index);
      const currentPhoto = orderedPhotos[idx];
      if (!currentPhoto.folderId) {
        toast('Esta foto no tiene una carpeta de origen para elegir otra.');
        return;
      }
      const usedIds = new Set(orderedPhotos.map((p) => p.id));
      const candidates = (await getPhotosByFolder(currentPhoto.folderId)).filter((p) => !usedIds.has(p.id));
      if (!candidates.length) {
        toast('No hay otras fotos disponibles en esa carpeta.');
        return;
      }
      const pickerURLs = new Map();
      for (const p of candidates) pickerURLs.set(p.id, URL.createObjectURL(p.blob));
      const chosenId = await photoSwapSheet(candidates, pickerURLs);
      pickerURLs.forEach((u) => URL.revokeObjectURL(u));
      if (!chosenId) return;
      const chosen = candidates.find((p) => p.id === chosenId);
      // El texto que ya se había escrito para esta fila (si la posición es
      // libre) se mantiene — es del CASILLERO, no de la foto puntual.
      if (captionDrafts.has(currentPhoto.id)) {
        captionDrafts.set(chosen.id, captionDrafts.get(currentPhoto.id));
        captionDrafts.delete(currentPhoto.id);
      }
      objectURLs.set(chosen.id, URL.createObjectURL(chosen.blob));
      orderedPhotos[idx] = chosen;
      renderList();
    });

    formatSelect.addEventListener('change', () => {
      format = getFormatById(formatSelect.value);
      localStorage.setItem(LAST_FORMAT_KEY, format.id);
      renderList();
    });

    function cleanup() {
      objectURLs.forEach((u) => URL.revokeObjectURL(u));
      overlay.remove();
    }

    overlay.querySelector('#er-close').addEventListener('click', () => {
      cleanup();
      resolve(false);
    });

    overlay.querySelector('#er-confirm').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Guardando…';

      const obra = overlay.querySelector('#er-obra').value.trim() || folder.name;
      const reportNumber = overlay.querySelector('#er-report-number').value.trim();
      const period = overlay.querySelector('#er-period').value.trim();

      for (let i = 0; i < orderedPhotos.length; i++) {
        const photo = orderedPhotos[i];
        const fixed = fixedLabelFor(format, i % 8);
        if (fixed) continue; // texto fijo: no es propiedad de la foto, no se guarda
        const value = (captionDrafts.get(photo.id) || '').trim();
        if (photo.title !== value) {
          photo.title = value;
          await updatePhoto(photo.id, { title: value });
        }
      }
      if (folder.id) {
        await updateFolder(folder.id, { reportNumber, reportPeriod: period });
      }

      try {
        const blob = await buildObraReportPDF(
          { obra, reportNumber, period, photos: orderedPhotos, format },
          (pageIndex, totalPages) => {
            btn.textContent = totalPages > 1 ? `Generando página ${pageIndex} de ${totalPages}…` : 'Generando PDF…';
          }
        );
        const filename = `${sanitizeFilename(obra)}${reportNumber ? '-informe-N' + sanitizeFilename(reportNumber) : '-informe'}.pdf`;
        downloadBlob(blob, filename);
        toast('Informe PDF generado.');
        cleanup();
        resolve(true);
      } catch (err) {
        console.error(err);
        toast('Error al generar el PDF.');
        btn.disabled = false;
        btn.textContent = 'Exportar';
      }
    });
  });
}
