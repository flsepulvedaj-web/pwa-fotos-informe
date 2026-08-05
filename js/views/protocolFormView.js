import {
  getProtocolInstance,
  updateProtocolInstance,
  getProtocolPhotosByInstance,
  addProtocolPhoto,
  deleteProtocolPhoto,
} from '../db.js';
import { CONTROL_STATUS, SIGNATURE_ROLES, GATING_ROLE } from '../protocolTemplates.js';
import { navigate } from '../router.js';
import { escapeHTML, formatDate, downscaleImageBlob, toast } from '../utils.js';
import { openSignaturePad } from '../signaturePad.js';

const HEADER_FIELDS = [
  { key: 'obra', label: 'Obra' },
  { key: 'cliente', label: 'Cliente' },
  { key: 'ubicacion', label: 'Ubicación' },
  { key: 'area', label: 'Área' },
  { key: 'plano', label: 'Plano' },
  { key: 'sector', label: 'Sector' },
];

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
 * Formulario de un protocolo. Todo se guarda solo (no hay botón "Guardar"
 * separado — igual que el resto de la app, cada cambio se escribe de
 * inmediato en IndexedDB), así que un borrador se puede dejar a medias en
 * cualquier momento y retomarse después desde "Protocolos en curso".
 */
export async function renderProtocolFormView(container, instanceId) {
  revokeAllURLs();

  let instance = await getProtocolInstance(instanceId);
  if (!instance) {
    navigate('/protocolos');
    return;
  }
  const photos = await getProtocolPhotosByInstance(instanceId);
  const readOnly = instance.status === 'emitted';
  const gatingSigned = !!instance.signatures?.[GATING_ROLE]?.signatureBlob;

  container.innerHTML = `
    <header class="app-header">
      <button class="icon-btn" id="btn-back" title="Volver">←</button>
      <span class="header-title">${escapeHTML(instance.templateTitle)}</span>
      <span class="protocol-status-pill protocol-status-${instance.status}">${readOnly ? 'Emitido' : 'Borrador'}</span>
    </header>
    <main class="view-content protocol-form">
      <section class="protocol-form-fields">
        ${HEADER_FIELDS.map((f) => `
          <label for="field-${f.key}">${f.label}</label>
          <input id="field-${f.key}" data-field="${f.key}" type="text" value="${escapeHTML(instance.header[f.key] || '')}" ${readOnly ? 'disabled' : ''} />
        `).join('')}
      </section>

      <section class="control-point-list" id="control-point-list">
        ${instance.controlPoints.map((cp, i) => renderControlPointRow(cp, i, readOnly)).join('')}
      </section>

      <section class="protocol-observaciones">
        <label for="observaciones">Observaciones</label>
        <textarea id="observaciones" placeholder="Notas adicionales…" ${readOnly ? 'disabled' : ''}>${escapeHTML(instance.observaciones || '')}</textarea>
      </section>

      <section class="protocol-photos">
        <h3>Fotografías</h3>
        <div class="protocol-photo-grid" id="protocol-photo-grid">
          ${photos.map((p) => `
            <div class="protocol-photo-item">
              <img src="${trackURL(URL.createObjectURL(p.blob))}" alt="Foto" />
              ${readOnly ? '' : `<button type="button" class="protocol-photo-delete" data-photo-id="${p.id}">✕</button>`}
            </div>
          `).join('')}
        </div>
        ${readOnly ? '' : `
          <button type="button" class="btn btn-secondary" id="btn-add-photos">📷 Agregar fotos</button>
          <input type="file" id="protocol-photo-input" accept="image/*" multiple hidden />
        `}
      </section>

      <section class="protocol-signatures">
        <h3>Firmas</h3>
        ${SIGNATURE_ROLES.map((role) => renderSignatureRow(role, instance.signatures?.[role.id], readOnly)).join('')}
      </section>

      ${readOnly ? '' : `
        <button type="button" class="btn btn-primary btn-emit" id="btn-emit" ${gatingSigned ? '' : 'disabled'}>
          ${gatingSigned ? 'Emitir protocolo' : 'Falta la firma de Inspección Técnica para emitir'}
        </button>
      `}
    </main>
  `;

  container.querySelector('#btn-back').addEventListener('click', () => navigate(`/protocolos/obra/${instance.obraId}`));

  if (readOnly) return; // solo lectura, nada más que conectar

  // Campos de encabezado: se guardan al perder el foco.
  container.querySelectorAll('[data-field]').forEach((input) => {
    input.addEventListener('blur', async () => {
      instance.header[input.dataset.field] = input.value;
      instance = await updateProtocolInstance(instanceId, { header: instance.header });
    });
  });

  // Puntos de control: un toque elige el estado (Cumple/No cumple/…).
  container.querySelector('#control-point-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.cp-status-btn');
    if (!btn) return;
    const row = btn.closest('.control-point-row');
    const index = Number(row.dataset.index);
    const statusId = btn.dataset.status;

    instance.controlPoints[index].status = statusId;
    row.querySelectorAll('.cp-status-btn').forEach((b) => b.classList.toggle('active', b.dataset.status === statusId));

    instance = await updateProtocolInstance(instanceId, { controlPoints: instance.controlPoints });
  });

  // Observaciones: guarda con un pequeño retraso mientras se escribe.
  let obsTimer = null;
  container.querySelector('#observaciones').addEventListener('input', (e) => {
    clearTimeout(obsTimer);
    const value = e.target.value;
    obsTimer = setTimeout(async () => {
      instance = await updateProtocolInstance(instanceId, { observaciones: value });
    }, 500);
  });

  // Fotografías: mismo mecanismo que "elegir de la galería" en Proyectos —
  // en el celular el propio selector del sistema ofrece cámara o galería,
  // no hace falta reconstruir toda la pantalla de cámara en vivo para
  // apenas ~4 fotos por protocolo.
  const photoInput = container.querySelector('#protocol-photo-input');
  container.querySelector('#btn-add-photos')?.addEventListener('click', () => photoInput.click());
  photoInput?.addEventListener('change', async () => {
    const files = [...photoInput.files];
    photoInput.value = '';
    if (!files.length) return;
    let added = 0;
    for (const file of files) {
      try {
        const blob = await downscaleImageBlob(file);
        await addProtocolPhoto({ instanceId, blob });
        added++;
      } catch (err) {
        console.error('Error agregando foto al protocolo:', err);
      }
    }
    if (added) renderProtocolFormView(container, instanceId);
  });

  container.querySelector('#protocol-photo-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('.protocol-photo-delete');
    if (!btn) return;
    await deleteProtocolPhoto(btn.dataset.photoId);
    renderProtocolFormView(container, instanceId);
  });

  // Firmas: canvas de pantalla completa, se guarda como blob.
  container.querySelector('.protocol-signatures').addEventListener('click', async (e) => {
    const signBtn = e.target.closest('.signature-sign-btn');
    const clearBtn = e.target.closest('.signature-clear-btn');
    if (!signBtn && !clearBtn) return;
    const roleId = (signBtn || clearBtn).dataset.role;
    const role = SIGNATURE_ROLES.find((r) => r.id === roleId);

    if (clearBtn) {
      const signatures = { ...instance.signatures };
      delete signatures[roleId];
      instance = await updateProtocolInstance(instanceId, { signatures });
      renderProtocolFormView(container, instanceId);
      return;
    }

    const nameInput = container.querySelector(`.signature-name-input[data-role="${roleId}"]`);
    const nombre = nameInput.value.trim();
    if (!nombre) {
      toast('Escribe el nombre antes de firmar.');
      nameInput.focus();
      return;
    }
    const signatureBlob = await openSignaturePad({ title: `Firma — ${role.label}` });
    if (!signatureBlob) return;

    const signatures = { ...instance.signatures, [roleId]: { nombre, fecha: Date.now(), signatureBlob } };
    instance = await updateProtocolInstance(instanceId, { signatures });
    renderProtocolFormView(container, instanceId);
  });

  // Guarda el nombre del firmante aunque todavía no haya firmado.
  container.querySelectorAll('.signature-name-input').forEach((input) => {
    input.addEventListener('blur', async () => {
      const roleId = input.dataset.role;
      const existing = instance.signatures?.[roleId];
      if (existing?.signatureBlob) return; // ya firmado: el nombre se cambia borrando y re-firmando
      const signatures = { ...instance.signatures, [roleId]: { nombre: input.value.trim(), fecha: null, signatureBlob: null } };
      instance = await updateProtocolInstance(instanceId, { signatures });
    });
  });

  container.querySelector('#btn-emit')?.addEventListener('click', () => {
    toast('La emisión del PDF y la subida a Drive vienen en la próxima etapa.');
  });
}

function renderControlPointRow(cp, index, readOnly) {
  return `
    <div class="control-point-row" data-index="${index}">
      <div class="control-point-label">${index + 1}. ${escapeHTML(cp.label)}</div>
      ${cp.instruction ? `<div class="control-point-instruction">${escapeHTML(cp.instruction)}</div>` : ''}
      <div class="cp-status-group">
        ${CONTROL_STATUS.map((s) => `
          <button type="button" class="cp-status-btn cp-status-${s.id} ${cp.status === s.id ? 'active' : ''}"
            data-status="${s.id}" ${readOnly ? 'disabled' : ''}>${s.label}</button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderSignatureRow(role, signature, readOnly) {
  const signed = !!signature?.signatureBlob;
  return `
    <div class="signature-row">
      <div class="signature-row-header">
        <span class="signature-role-label">${escapeHTML(role.label)}</span>
        ${role.id === GATING_ROLE ? '<span class="signature-required-tag">Obligatoria</span>' : ''}
      </div>
      <input type="text" class="signature-name-input" data-role="${role.id}" placeholder="Nombre"
        value="${escapeHTML(signature?.nombre || '')}" ${readOnly || signed ? 'disabled' : ''} />
      ${signed ? `
        <img class="signature-preview" src="${trackURL(URL.createObjectURL(signature.signatureBlob))}" alt="Firma de ${escapeHTML(signature.nombre)}" />
        <div class="signature-meta">Firmado el ${formatDate(signature.fecha)}</div>
        ${readOnly ? '' : `<button type="button" class="btn btn-secondary signature-clear-btn" data-role="${role.id}">Borrar firma</button>`}
      ` : readOnly ? '' : `
        <button type="button" class="btn btn-secondary signature-sign-btn" data-role="${role.id}">✍️ Firmar</button>
      `}
    </div>
  `;
}
