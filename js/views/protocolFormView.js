import { getProtocolInstance, updateProtocolInstance } from '../db.js';
import { CONTROL_STATUS } from '../protocolTemplates.js';
import { navigate } from '../router.js';
import { escapeHTML } from '../utils.js';

const HEADER_FIELDS = [
  { key: 'obra', label: 'Obra' },
  { key: 'cliente', label: 'Cliente' },
  { key: 'ubicacion', label: 'Ubicación' },
  { key: 'area', label: 'Área' },
  { key: 'plano', label: 'Plano' },
  { key: 'sector', label: 'Sector' },
];

/**
 * Formulario de un protocolo. Todo se guarda solo (no hay botón "Guardar"
 * separado — igual que el resto de la app, cada cambio se escribe de
 * inmediato en IndexedDB), así que un borrador se puede dejar a medias en
 * cualquier momento y retomarse después desde "Protocolos en curso".
 */
export async function renderProtocolFormView(container, instanceId) {
  let instance = await getProtocolInstance(instanceId);
  if (!instance) {
    navigate('/protocolos');
    return;
  }

  container.innerHTML = `
    <header class="app-header">
      <button class="icon-btn" id="btn-back" title="Volver">←</button>
      <span class="header-title">${escapeHTML(instance.templateTitle)}</span>
      <span class="protocol-status-pill protocol-status-${instance.status}">${instance.status === 'emitted' ? 'Emitido' : 'Borrador'}</span>
    </header>
    <main class="view-content protocol-form">
      <section class="protocol-form-fields">
        ${HEADER_FIELDS.map((f) => `
          <label for="field-${f.key}">${f.label}</label>
          <input id="field-${f.key}" data-field="${f.key}" type="text" value="${escapeHTML(instance.header[f.key] || '')}" ${instance.status === 'emitted' ? 'disabled' : ''} />
        `).join('')}
      </section>

      <section class="control-point-list" id="control-point-list">
        ${instance.controlPoints.map((cp, i) => renderControlPointRow(cp, i, instance.status)).join('')}
      </section>

      <section class="protocol-observaciones">
        <label for="observaciones">Observaciones</label>
        <textarea id="observaciones" placeholder="Notas adicionales…" ${instance.status === 'emitted' ? 'disabled' : ''}>${escapeHTML(instance.observaciones || '')}</textarea>
      </section>
    </main>
  `;

  container.querySelector('#btn-back').addEventListener('click', () => navigate(`/protocolos/obra/${instance.obraId}`));

  if (instance.status === 'emitted') return; // solo lectura, nada más que conectar

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
}

function renderControlPointRow(cp, index, instanceStatus) {
  return `
    <div class="control-point-row" data-index="${index}">
      <div class="control-point-label">${index + 1}. ${escapeHTML(cp.label)}</div>
      ${cp.instruction ? `<div class="control-point-instruction">${escapeHTML(cp.instruction)}</div>` : ''}
      <div class="cp-status-group">
        ${CONTROL_STATUS.map((s) => `
          <button type="button" class="cp-status-btn cp-status-${s.id} ${cp.status === s.id ? 'active' : ''}"
            data-status="${s.id}" ${instanceStatus === 'emitted' ? 'disabled' : ''}>${s.label}</button>
        `).join('')}
      </div>
    </div>
  `;
}
