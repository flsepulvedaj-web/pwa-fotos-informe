import {
  getObra,
  updateObra,
  getRdiSolicitudesByObra,
  addRdiSolicitud,
  updateRdiSolicitud,
  deleteRdiSolicitud,
} from '../db.js';
import {
  computeRdiKPI,
  computeFrecuenciaRespuesta,
  computeRdiPendientesOrdenadas,
  rdiDias,
} from '../rdiDashboard.js';
import { openFolderPicker, isSignedIn, getSignedInEmail } from '../googleDrive.js';
import { uploadRdiSolicitud, syncRdiFromDrive } from '../rdiSync.js';
import { uploadObrasIndex } from '../obraSync.js';
import { isAdmin } from '../permissions.js';
import { driveLinkSectionHTML, wireDriveLinkSection } from '../driveLinkSection.js';
import { navigate } from '../router.js';
import { escapeHTML, confirmDialog, toast } from '../utils.js';

const RESPUESTA_VALIDA_LABEL = { true: 'Sí', false: 'No', null: '—' };

function formatDateEs(iso) {
  if (!iso) return '—';
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * RDI (requerimientos de información al mandante): lo que más importa acá
 * es cuánto se demora el mandante en responder — le da días a la
 * constructora y le sirve al ITO como argumento para presionar. Por eso el
 * dashboard destaca el promedio de días de respuesta y las pendientes más
 * atrasadas primero, antes que el formulario de carga.
 */
export async function renderRdiObraView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  const admin = isAdmin(await getSignedInEmail());
  let items = await getRdiSolicitudesByObra(obraId);
  let editingId = null;

  async function syncFromDrive({ auto }) {
    if (!obra.rdiDriveFolderId) return;
    if (auto && !isSignedIn()) return;
    try {
      const changed = await syncRdiFromDrive(obraId, obra.rdiDriveFolderId);
      items = await getRdiSolicitudesByObra(obraId);
      if (changed) {
        toast(`📥 ${changed} RDI traída(s) de Drive.`);
        paint();
      } else if (!auto) {
        toast('Ya tenés todo lo más reciente.');
      }
    } catch (err) {
      console.error('Error sincronizando RDI desde Drive:', err);
      if (!auto) toast('No se pudo conectar con Drive.');
    }
  }

  function paint() {
    const editing = editingId ? items.find((r) => r.id === editingId) : null;
    const kpi = computeRdiKPI(items);
    const frecuencia = computeFrecuenciaRespuesta(items);
    const pendientesOrdenadas = computeRdiPendientesOrdenadas(items);

    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">RDI — ${escapeHTML(obra.name)}</span>
      </header>
      <main class="view-content">
        <section class="kpi-tiles">
          <div class="kpi-tile">
            <div class="kpi-value">${kpi.promedioDias !== null ? kpi.promedioDias + 'd' : '—'}</div>
            <div class="kpi-label">Promedio días de respuesta</div>
          </div>
          <div class="kpi-tile">
            <div class="kpi-value">${kpi.pendientes}</div>
            <div class="kpi-label">RDI sin responder</div>
          </div>
          <div class="kpi-tile">
            <div class="kpi-value">${kpi.total}</div>
            <div class="kpi-label">RDI totales</div>
          </div>
        </section>

        ${pendientesOrdenadas.length ? `
          <section class="incumplimientos-panel">
            <h3>⚠️ Sin responder — más atrasadas primero</h3>
            ${pendientesOrdenadas.slice(0, 5).map((r) => `
              <div class="incumplimiento-row">
                <div class="incumplimiento-main">
                  <span class="incumplimiento-tag">${r.numero ? `N° ${escapeHTML(r.numero)}` : 'RDI'}</span>
                  <span class="incumplimiento-label">${escapeHTML(r.descripcion || '(sin descripción)')}</span>
                  <span class="incumplimiento-meta">${r.dias} día(s) sin respuesta — enviado ${formatDateEs(r.fechaEnvio)}</span>
                </div>
              </div>
            `).join('')}
          </section>
        ` : `
          <div class="incumplimientos-ok">✅ Sin RDI pendientes</div>
        `}

        <section class="rdi-freq-wrap">
          <h3 class="rdi-freq-title">Frecuencia de respuesta</h3>
          <table class="rdi-freq-table">
            <thead>
              <tr><th>Días</th><th>Respondidas</th><th>Pendientes</th></tr>
            </thead>
            <tbody>
              ${frecuencia.map((f) => `
                <tr>
                  <td>${f.label}</td>
                  <td>${f.respondidas}</td>
                  <td>${f.pendientes}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </section>

        ${driveLinkSectionHTML({
          admin,
          folderId: obra.rdiDriveFolderId,
          folderName: obra.rdiDriveFolderName,
          hintText: 'Vinculá una carpeta de Drive para que lo que cargue cualquiera del equipo te llegue a vos también.',
        })}

        <form class="ssma-form" id="rdi-form">
          <h2>${editingId ? 'Editar RDI' : 'Nuevo RDI'}</h2>

          <label for="rdi-numero">N°</label>
          <input type="text" id="rdi-numero" value="${escapeHTML(editing?.numero || '')}" />

          <label for="rdi-fecha">Fecha</label>
          <input type="date" id="rdi-fecha" value="${editing?.fecha || todayLocalISO()}" />

          <label for="rdi-emisor">Emisor</label>
          <input type="text" id="rdi-emisor" placeholder="Quién lo redacta" value="${escapeHTML(editing?.emisor || '')}" />

          <label for="rdi-cargo">Cargo</label>
          <input type="text" id="rdi-cargo" value="${escapeHTML(editing?.cargo || '')}" />

          <label for="rdi-especialidad">Especialidad</label>
          <input type="text" id="rdi-especialidad" value="${escapeHTML(editing?.especialidad || '')}" />

          <label for="rdi-area">Elemento o área del proyecto</label>
          <input type="text" id="rdi-area" value="${escapeHTML(editing?.elementoArea || '')}" />

          <label for="rdi-plano">Plano o documento asociado</label>
          <input type="text" id="rdi-plano" value="${escapeHTML(editing?.planoDocumento || '')}" />

          <label for="rdi-descripcion">Descripción</label>
          <textarea id="rdi-descripcion" maxlength="500">${escapeHTML(editing?.descripcion || '')}</textarea>

          <label class="rdi-checkbox-label">
            <input type="checkbox" id="rdi-antecedentes" ${editing?.antecedentesAdjuntos ? 'checked' : ''} />
            Trae antecedentes adjuntos
          </label>

          <label for="rdi-envio">Fecha de envío al mandante</label>
          <input type="date" id="rdi-envio" value="${editing?.fechaEnvio || todayLocalISO()}" />

          <label for="rdi-recepcion">Fecha de recepción de la respuesta (vacío = pendiente)</label>
          <input type="date" id="rdi-recepcion" value="${editing?.fechaRecepcion || ''}" />

          <label for="rdi-respuesta">Respuesta</label>
          <textarea id="rdi-respuesta" maxlength="1000">${escapeHTML(editing?.respuesta || '')}</textarea>

          <label for="rdi-valida">¿Respuesta válida?</label>
          <select id="rdi-valida">
            <option value="" ${editing?.respuestaValida == null ? 'selected' : ''}>—</option>
            <option value="si" ${editing?.respuestaValida === true ? 'selected' : ''}>Sí</option>
            <option value="no" ${editing?.respuestaValida === false ? 'selected' : ''}>No</option>
          </select>

          <label for="rdi-accion">Acción</label>
          <input type="text" id="rdi-accion" value="${escapeHTML(editing?.accion || '')}" />

          <div class="ssma-form-actions">
            ${editingId ? '<button type="button" class="btn btn-secondary" id="rdi-cancel-edit">Cancelar edición</button>' : ''}
            <button type="submit" class="btn btn-primary">${editingId ? 'Guardar cambios' : 'Guardar'}</button>
          </div>
        </form>

        <h2 class="ssma-history-title">Historial</h2>
        ${items.length ? `
          <section class="ssma-history-list">
            ${items.map((r) => {
              const dias = rdiDias(r);
              return `
                <div class="ssma-history-row">
                  <button type="button" class="ssma-history-main" data-edit-id="${r.id}">
                    <span class="ssma-history-date">${r.numero ? `N° ${escapeHTML(r.numero)} — ` : ''}Enviado ${formatDateEs(r.fechaEnvio)}</span>
                    <span class="ssma-history-count">${escapeHTML(r.descripcion || '(sin descripción)')}</span>
                    <span class="ssma-history-split">${r.fechaRecepcion ? `✅ Respondido en ${dias}d (${formatDateEs(r.fechaRecepcion)})` : `⏳ ${dias}d sin respuesta`} · Válida: ${RESPUESTA_VALIDA_LABEL[r.respuestaValida]}</span>
                  </button>
                  <button type="button" class="icon-btn ssma-delete-btn" data-delete-id="${r.id}" title="Eliminar">🗑️</button>
                </div>
              `;
            }).join('')}
          </section>
        ` : `
          <div class="empty-state">
            <p>Todavía no hay RDI cargados.</p>
          </div>
        `}
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate(`/control/obra/${obraId}`));

    wireDriveLinkSection(container, {
      onLink: async () => {
        try {
          const picked = await openFolderPicker();
          if (!picked) return;
          await updateObra(obraId, { rdiDriveFolderId: picked.id, rdiDriveFolderName: picked.name });
          obra.rdiDriveFolderId = picked.id;
          obra.rdiDriveFolderName = picked.name;
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

    const cancelBtn = container.querySelector('#rdi-cancel-edit');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { editingId = null; paint(); });

    container.querySelector('#rdi-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = container.querySelector('#rdi-valida').value;
      const fields = {
        numero: container.querySelector('#rdi-numero').value.trim(),
        fecha: container.querySelector('#rdi-fecha').value,
        emisor: container.querySelector('#rdi-emisor').value.trim(),
        cargo: container.querySelector('#rdi-cargo').value.trim(),
        especialidad: container.querySelector('#rdi-especialidad').value.trim(),
        elementoArea: container.querySelector('#rdi-area').value.trim(),
        planoDocumento: container.querySelector('#rdi-plano').value.trim(),
        descripcion: container.querySelector('#rdi-descripcion').value.trim(),
        antecedentesAdjuntos: container.querySelector('#rdi-antecedentes').checked,
        fechaEnvio: container.querySelector('#rdi-envio').value,
        fechaRecepcion: container.querySelector('#rdi-recepcion').value || null,
        respuesta: container.querySelector('#rdi-respuesta').value.trim(),
        respuestaValida: val === '' ? null : val === 'si',
        accion: container.querySelector('#rdi-accion').value.trim(),
      };

      if (!fields.fechaEnvio) {
        toast('Elegí la fecha de envío.');
        return;
      }

      let saved;
      if (editingId) {
        saved = await updateRdiSolicitud(editingId, fields);
        toast('RDI actualizado.');
        editingId = null;
      } else {
        saved = await addRdiSolicitud({ obraId, ...fields });
        toast('RDI guardado.');
      }

      if (obra.rdiDriveFolderId) {
        const ok = await uploadRdiSolicitud(obra.rdiDriveFolderId, saved);
        if (!ok) toast('⚠️ No se pudo subir a Drive (quedó guardado en tu teléfono, se reintenta después).');
      }

      items = await getRdiSolicitudesByObra(obraId);
      paint();
    });

    container.querySelectorAll('.ssma-history-main').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingId = btn.dataset.editId;
        paint();
        container.querySelector('#rdi-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    container.querySelectorAll('.ssma-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('¿Eliminar este RDI? No se puede deshacer. Ojo: si estaba compartido con el equipo, la copia en Drive no se borra sola.');
        if (!ok) return;
        await deleteRdiSolicitud(btn.dataset.deleteId);
        if (editingId === btn.dataset.deleteId) editingId = null;
        items = await getRdiSolicitudesByObra(obraId);
        toast('RDI eliminado.');
        paint();
      });
    });
  }

  paint();

  if (obra.rdiDriveFolderId) {
    syncFromDrive({ auto: true });
  }
}
