import { getProtocolInstance, getObra } from '../db.js';
import { navigate } from '../router.js';
import { escapeHTML, formatDate } from '../utils.js';

/**
 * Formulario de un protocolo. Por ahora (etapa de validación de la
 * extracción) es de solo lectura: muestra el encabezado y los puntos de
 * control copiados de la plantilla. El llenado interactivo (Cumple/No
 * cumple/…, observaciones, fotos, firmas) se agrega en la siguiente etapa.
 */
export async function renderProtocolFormView(container, instanceId) {
  const instance = await getProtocolInstance(instanceId);
  if (!instance) {
    navigate('/protocolos');
    return;
  }
  const obra = await getObra(instance.obraId);

  container.innerHTML = `
    <header class="app-header">
      <button class="icon-btn" id="btn-back" title="Volver">←</button>
      <span class="header-title">${escapeHTML(instance.templateTitle)}</span>
    </header>
    <main class="view-content protocol-form">
      <section class="protocol-form-header">
        <p><strong>Obra:</strong> ${escapeHTML(obra?.name || '—')}</p>
        <p><strong>Estado:</strong> ${instance.status === 'emitted' ? 'Emitido' : 'Borrador'}</p>
        <p><strong>Creado:</strong> ${formatDate(instance.createdAt)}</p>
      </section>
      <section class="control-point-list">
        ${instance.controlPoints.map((cp, i) => `
          <div class="control-point-row">
            <div class="control-point-label">${i + 1}. ${escapeHTML(cp.label)}</div>
            ${cp.instruction ? `<div class="control-point-instruction">${escapeHTML(cp.instruction)}</div>` : ''}
            <div class="control-point-status">${cp.status ? escapeHTML(cp.status) : '(sin marcar todavía)'}</div>
          </div>
        `).join('')}
      </section>
    </main>
  `;

  container.querySelector('#btn-back').addEventListener('click', () => navigate(`/protocolos/obra/${instance.obraId}`));
}
