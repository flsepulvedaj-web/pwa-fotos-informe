export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function formatDate(timestamp) {
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function dataURLToBlob(dataURL) {
  return fetch(dataURL).then((res) => res.blob());
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/**
 * Modal genérico con uno o más campos de texto.
 * fields: [{ name, label, placeholder, value, type: 'text'|'textarea', maxlength }]
 * Devuelve un objeto { [name]: value } al confirmar, o null si se cancela.
 */
export function promptDialog({ title, fields, confirmLabel = 'Guardar', cancelLabel = 'Cancelar' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const fieldsHTML = fields
      .map((f, i) => {
        const id = `field-${i}`;
        const label = `<label for="${id}">${escapeHTML(f.label)}</label>`;
        if (f.type === 'textarea') {
          return `${label}<textarea id="${id}" placeholder="${escapeHTML(f.placeholder || '')}" maxlength="${f.maxlength || 500}">${escapeHTML(f.value || '')}</textarea>`;
        }
        return `${label}<input id="${id}" type="text" placeholder="${escapeHTML(f.placeholder || '')}" value="${escapeHTML(f.value || '')}" maxlength="${f.maxlength || 100}" />`;
      })
      .join('');

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h2>${escapeHTML(title)}</h2>
        <form class="modal-form">
          ${fieldsHTML}
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" data-action="cancel">${escapeHTML(cancelLabel)}</button>
            <button type="submit" class="btn btn-primary" data-action="confirm">${escapeHTML(confirmLabel)}</button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(overlay);

    const form = overlay.querySelector('.modal-form');
    const firstInput = overlay.querySelector('input, textarea');
    if (firstInput) firstInput.focus();

    function cleanup() {
      overlay.remove();
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve(null);
      }
    });

    overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => {
      cleanup();
      resolve(null);
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const values = {};
      fields.forEach((f, i) => {
        values[f.name] = overlay.querySelector(`#field-${i}`).value.trim();
      });
      cleanup();
      resolve(values);
    });
  });
}

export function confirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="alertdialog" aria-modal="true">
        <p class="modal-message">${escapeHTML(message)}</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-action="cancel">Cancelar</button>
          <button type="button" class="btn btn-danger" data-action="confirm">Eliminar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    function cleanup(result) {
      overlay.remove();
      resolve(result);
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });
    overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => cleanup(false));
    overlay.querySelector('[data-action="confirm"]').addEventListener('click', () => cleanup(true));
  });
}

export function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 300);
  }, 2200);
}
