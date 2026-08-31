// Bloque "vincular carpeta de Drive" reutilizado en cada sub-módulo
// (Personal, Checklist, Avance, Presupuesto, RDI, Subcontratos, Organismos,
// Informe Semanal) — antes cada uno tenía su propia copia casi idéntica de
// este HTML + wiring, lo que hacía fácil que un cambio (como este) quedara
// aplicado en 7 archivos y olvidado en el octavo.
//
// SOLO el admin puede elegir o cambiar la carpeta — vincular la carpeta
// equivocada rompe la sincronización para todo el equipo, así que no vale
// la pena dejar que cualquiera lo haga por error. El resto del equipo solo
// ve el estado (vinculada o no) y puede sincronizar (leer), nunca elegir.
import { escapeHTML } from './utils.js';

export function driveLinkSectionHTML({ admin, folderId, folderName, hintText, syncLabel = '🔄 Buscar cambios' }) {
  if (folderId) {
    return `
      <section class="avance-drive-link">
        <div class="avance-drive-linked">☁️ Compartido en: <strong>${escapeHTML(folderName || '')}</strong></div>
        <div class="avance-drive-actions">
          <button type="button" class="btn btn-secondary" id="btn-check-drive">${syncLabel}</button>
          ${admin ? '<button type="button" class="btn btn-secondary" id="btn-change-drive-folder">Cambiar carpeta</button>' : ''}
        </div>
      </section>
    `;
  }
  if (admin) {
    return `
      <section class="avance-drive-link">
        <button type="button" class="btn btn-primary" id="btn-link-drive-folder">🔗 Compartir con el equipo (Drive)</button>
        <p class="avance-upload-hint">${hintText}</p>
      </section>
    `;
  }
  return `
    <section class="avance-drive-link">
      <p class="avance-upload-hint">Todavía no está vinculada a Drive — pedile al admin que la vincule para compartir esto con el equipo.</p>
    </section>
  `;
}

/** Engancha los botones del bloque de arriba — `onLink` se usa tanto para
 * "vincular" como para "cambiar carpeta" (misma acción, elegir una nueva). */
export function wireDriveLinkSection(container, { onLink, onSync }) {
  container.querySelector('#btn-link-drive-folder')?.addEventListener('click', onLink);
  container.querySelector('#btn-change-drive-folder')?.addEventListener('click', onLink);
  container.querySelector('#btn-check-drive')?.addEventListener('click', onSync);
}
