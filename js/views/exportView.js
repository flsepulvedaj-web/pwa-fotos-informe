import { buildObraReportPDF, downloadBlob, sanitizeFilename } from '../pdfExport.js';
import { updatePhoto, updateFolder } from '../db.js';
import { escapeHTML, toast } from '../utils.js';

function defaultPeriod() {
  try {
    const label = new Date().toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    return '';
  }
}

/**
 * Pantalla completa previa a exportar: encabezado del informe (obra, N°,
 * período) + lista de fotos con su descripción ("Imagen N:"), pensada para
 * recorrerse rápido aunque haya cientos de fotos. Al confirmar, guarda las
 * descripciones en cada foto y el N°/período en la carpeta (para precargarlos
 * la próxima vez), arma el PDF con el formato oficial y lo descarga.
 * Devuelve true si se exportó, false si se canceló.
 */
export function openExportReviewScreen(photos, folder) {
  return new Promise((resolve) => {
    const objectURLs = [];
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
        </div>
        <div class="er-photo-list" id="er-photo-list"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const list = overlay.querySelector('#er-photo-list');
    list.innerHTML = photos
      .map((p, i) => {
        const url = URL.createObjectURL(p.blob);
        objectURLs.push(url);
        return `
          <div class="er-photo-row">
            <img src="${url}" alt="Imagen ${i + 1}" loading="lazy" />
            <div class="er-photo-fields">
              <span class="er-photo-label">Imagen ${i + 1}</span>
              <input class="er-caption-input" type="text" data-photo-id="${p.id}" value="${escapeHTML(p.title || '')}" placeholder="Descripción para el informe" />
            </div>
          </div>
        `;
      })
      .join('');

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

      const captionInputs = overlay.querySelectorAll('.er-caption-input');
      for (const input of captionInputs) {
        const photoId = input.dataset.photoId;
        const value = input.value.trim();
        const photo = photos.find((p) => p.id === photoId);
        if (photo && photo.title !== value) {
          photo.title = value;
          await updatePhoto(photoId, { title: value });
        }
      }
      if (folder.id) {
        await updateFolder(folder.id, { reportNumber, reportPeriod: period });
      }

      try {
        const blob = await buildObraReportPDF(
          { obra, reportNumber, period, photos },
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
