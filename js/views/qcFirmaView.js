import { escapeHTML, toast, promptDialog } from '../utils.js';
import { openSignaturePad } from '../signaturePad.js';
import { qcNewId } from '../qcStore.js';
import {
  idPin,
  pinValido,
  crearRegistroPin,
  tienePin,
  verificarPin,
  estadoBloqueo,
  registrarFallo,
  limpiarFallos,
  leerCachePin,
  guardarCachePin,
  firmaComoDataURL,
  huellaDe,
  contenidoFirmado,
  TIPO_CERT,
  ACCION_CERT,
} from '../qcFirma.js';

const imagenSegura = (d) => (typeof d === 'string' && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(d) ? d : '');
const fechaHora = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short' });
};

/**
 * ctx: { getData, commit, reload, paint, miCorreo, isAdmin, yoSoy, nombreDe }
 */

function abrirModal(html) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal qc-obs-modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

const registroPin = (ctx) => ctx.getData().pines?.find((p) => p.id === idPin(ctx.miCorreo) && !p.anulado) || null;

/** Cuadro para crear (o cambiar) el PIN y la firma dibujada. Devuelve { extraOps, firmaDibujada } o null. */
function modalCrearPin(ctx, { cambiar }) {
  return new Promise((resolve) => {
    const actual = registroPin(ctx);
    let firma = cambiar ? actual?.firmaDibujada || '' : '';
    const ov = abrirModal(`
      <h2>${cambiar ? 'Cambiar mi PIN o mi firma' : 'Crea tu PIN y tu firma'}</h2>
      <p class="modal-message">El PIN (4 a 6 números) y tu firma dibujada se piden cada vez que certifiques algo. Nadie más puede firmar por ti sin tu PIN.</p>
      ${cambiar ? '<label>PIN actual <input type="password" name="actual" inputmode="numeric" maxlength="6" autocomplete="off" /></label>' : ''}
      <label>${cambiar ? 'PIN nuevo' : 'PIN'} <input type="password" name="pin" inputmode="numeric" maxlength="6" autocomplete="off" /></label>
      <label>Repite el PIN <input type="password" name="pin2" inputmode="numeric" maxlength="6" autocomplete="off" /></label>
      <div class="qc-firma-box"><img id="firma-vista" alt="Tu firma" ${imagenSegura(firma) ? `src="${imagenSegura(firma)}"` : 'hidden'} /><button type="button" class="btn btn-secondary" id="firma-dibujar">✍️ ${firma ? 'Dibujar de nuevo' : 'Dibujar mi firma'}</button></div>
      <p class="qc-hint" id="firma-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancelar</button>
        <button type="button" class="btn btn-primary" data-act="ok">Guardar</button>
      </div>`);
    const error = (t) => { const p = ov.querySelector('#firma-error'); p.textContent = t; p.hidden = !t; };
    ov.querySelector('#firma-dibujar').addEventListener('click', async () => {
      const blob = await openSignaturePad({ title: 'Tu firma' });
      if (!blob) return;
      firma = await firmaComoDataURL(blob);
      const img = ov.querySelector('#firma-vista');
      img.src = firma;
      img.hidden = false;
    });
    ov.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'cancel') { ov.remove(); resolve(null); return; }
      const v = (n) => ov.querySelector(`[name="${n}"]`)?.value.trim() || '';
      if (cambiar) {
        const bloqueo = estadoBloqueo(ctx.miCorreo);
        if (bloqueo.bloqueado) return error('Demasiados intentos. Espera unos minutos.');
        if (!(await verificarPin(actual, v('actual')))) { registrarFallo(ctx.miCorreo); return error('El PIN actual no es correcto.'); }
        limpiarFallos(ctx.miCorreo);
      }
      if (!pinValido(v('pin'))) return error('El PIN debe tener entre 4 y 6 números.');
      if (v('pin') !== v('pin2')) return error('Los dos PIN no coinciden.');
      if (!imagenSegura(firma)) return error('Dibuja tu firma con el dedo o el mouse.');
      const registro = await crearRegistroPin(ctx.miCorreo, v('pin'), firma);
      guardarCachePin(ctx.miCorreo, registro);
      ov.remove();
      resolve({ extraOps: [{ op: 'set', table: 'pines', id: idPin(ctx.miCorreo), patch: registro }], firmaDibujada: firma });
    });
  });
}

/**
 * Pide el PIN para certificar algo. Si la persona todavía no tiene PIN, primero
 * se lo hace crear. Devuelve { comentario, firmaDibujada, extraOps } o null si cancela.
 */
export async function pedirFirma(ctx, { titulo, resumen }) {
  if (!ctx.miCorreo) {
    toast('Para firmar tienes que iniciar sesión con Google.');
    return null;
  }
  let registro = registroPin(ctx);
  if (!tienePin(registro)) {
    // ¿Ya tiene PIN y firma de otro proyecto en este aparato? (salvo que un administrador se los haya restablecido)
    const guardado = registro?.reiniciado ? null : leerCachePin(ctx.miCorreo);
    if (guardado) {
      const reuso = await modalReutilizarPin(ctx, guardado, { titulo, resumen });
      if (reuso === null) return null;
      if (reuso !== 'nuevo') return reuso;
    }
    const nuevo = await modalCrearPin(ctx, { cambiar: false });
    if (!nuevo) return null;
    // Acaba de crear su PIN y su firma: se firma en el mismo paso.
    const comentario = await comentarioOpcional(titulo, resumen);
    if (comentario === null) return null;
    return { comentario, firmaDibujada: nuevo.firmaDibujada, extraOps: nuevo.extraOps };
  }
  return new Promise((resolve) => {
    const ov = abrirModal(`
      <h2>✍️ ${escapeHTML(titulo)}</h2>
      <p class="modal-message">${escapeHTML(resumen || '')}</p>
      <div class="qc-firma-box"><img src="${imagenSegura(registro.firmaDibujada)}" alt="Tu firma" /></div>
      <label>Comentario (opcional) <textarea name="comentario" rows="2" maxlength="500"></textarea></label>
      <label>Tu PIN <input type="password" name="pin" inputmode="numeric" maxlength="6" autocomplete="off" /></label>
      <p class="qc-hint" id="firma-error" hidden></p>
      <div class="modal-actions qc-obs-actions">
        <button type="button" class="btn btn-secondary" data-act="cambiar">Cambiar PIN o firma</button>
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancelar</button>
        <button type="button" class="btn btn-primary" data-act="ok">Firmar</button>
      </div>`);
    const error = (t) => { const p = ov.querySelector('#firma-error'); p.textContent = t; p.hidden = !t; };
    ov.querySelector('[name="pin"]').focus();
    ov.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'cancel') { ov.remove(); resolve(null); return; }
      if (act === 'cambiar') {
        const nuevo = await modalCrearPin(ctx, { cambiar: true });
        if (!nuevo) return;
        ov.remove();
        resolve({ comentario: ov.querySelector('[name="comentario"]').value.trim(), firmaDibujada: nuevo.firmaDibujada, extraOps: nuevo.extraOps });
        return;
      }
      const bloqueo = estadoBloqueo(ctx.miCorreo);
      if (bloqueo.bloqueado) return error(`Demasiados intentos fallidos. Vuelve a intentar a las ${new Date(bloqueo.hasta).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}.`);
      const pin = ov.querySelector('[name="pin"]').value.trim();
      if (!(await verificarPin(registro, pin))) {
        registrarFallo(ctx.miCorreo);
        const resto = estadoBloqueo(ctx.miCorreo);
        return error(resto.bloqueado ? 'PIN incorrecto. Quedaste bloqueado por 5 minutos.' : `PIN incorrecto. Te quedan ${resto.restantes} intento(s).`);
      }
      limpiarFallos(ctx.miCorreo);
      guardarCachePin(ctx.miCorreo, registro);
      const comentario = ov.querySelector('[name="comentario"]').value.trim();
      ov.remove();
      resolve({ comentario, firmaDibujada: registro.firmaDibujada, extraOps: [] });
    });
  });
}

/** Reutiliza el PIN y la firma de otro proyecto: basta con escribir el PIN de siempre. Devuelve el resultado de la firma, 'nuevo' o null. */
function modalReutilizarPin(ctx, guardado, { titulo, resumen }) {
  return new Promise((resolve) => {
    const ov = abrirModal(`
      <h2>✍️ ${escapeHTML(titulo)}</h2>
      <p class="modal-message">${escapeHTML(resumen || '')}</p>
      <p class="modal-message">Ya tienes un PIN y una firma de otro proyecto. Escribe tu PIN de siempre para usarlos aquí.</p>
      <div class="qc-firma-box"><img src="${imagenSegura(guardado.firmaDibujada)}" alt="Tu firma" /></div>
      <label>Comentario (opcional) <textarea name="comentario" rows="2" maxlength="500"></textarea></label>
      <label>Tu PIN <input type="password" name="pin" inputmode="numeric" maxlength="6" autocomplete="off" /></label>
      <p class="qc-hint" id="firma-error" hidden></p>
      <div class="modal-actions qc-obs-actions">
        <button type="button" class="btn btn-secondary" data-act="nuevo">Crear otro PIN</button>
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancelar</button>
        <button type="button" class="btn btn-primary" data-act="ok">Firmar</button>
      </div>`);
    const error = (t) => { const p = ov.querySelector('#firma-error'); p.textContent = t; p.hidden = !t; };
    ov.querySelector('[name="pin"]').focus();
    ov.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'cancel') { ov.remove(); resolve(null); return; }
      if (act === 'nuevo') { ov.remove(); resolve('nuevo'); return; }
      const bloqueo = estadoBloqueo(ctx.miCorreo);
      if (bloqueo.bloqueado) return error('Demasiados intentos fallidos. Espera unos minutos.');
      if (!(await verificarPin(guardado, ov.querySelector('[name="pin"]').value.trim()))) {
        registrarFallo(ctx.miCorreo);
        const resto = estadoBloqueo(ctx.miCorreo);
        return error(resto.bloqueado ? 'PIN incorrecto. Quedaste bloqueado por 5 minutos.' : `PIN incorrecto. Te quedan ${resto.restantes} intento(s).`);
      }
      limpiarFallos(ctx.miCorreo);
      const comentario = ov.querySelector('[name="comentario"]').value.trim();
      ov.remove();
      resolve({ comentario, firmaDibujada: guardado.firmaDibujada, extraOps: [{ op: 'set', table: 'pines', id: idPin(ctx.miCorreo), patch: { ...guardado, reiniciado: false } }] });
    });
  });
}

async function comentarioOpcional(titulo, resumen) {
  const r = await promptDialog({
    title: titulo,
    fields: [{ name: 'comentario', label: `${resumen || ''} Comentario (opcional)`, type: 'textarea', maxlength: 500 }],
    confirmLabel: 'Firmar',
  });
  return r ? (r.comentario || '').trim() : null;
}

/**
 * Certifica algo: pide PIN, y en UN solo evento guarda los cambios (`cambios`)
 * junto con el registro de la certificación. Devuelve true si se firmó.
 */
export async function certificar(ctx, { tipo, registro, refTabla, refCodigo, accion, nivel = 1, nota, cambios = [], resumen }) {
  const firma = await pedirFirma(ctx, { titulo: `${TIPO_CERT[tipo]} ${refCodigo}: ${ACCION_CERT[accion] || accion}`, resumen });
  if (!firma) return false;
  const yo = ctx.yoSoy();
  const cert = {
    tipo,
    refTabla,
    refId: registro.id,
    refCodigo: String(refCodigo),
    accion,
    nivel,
    firmadoPor: ctx.miCorreo,
    firmanteNombre: yo?.nombre || ctx.miCorreo,
    firmanteCargo: yo?.cargo || '',
    firmanteRol: yo?.rol || (ctx.isAdmin ? 'administrador' : ''),
    fechaHora: new Date().toISOString(),
    comentario: firma.comentario || '',
    firmaDibujada: firma.firmaDibujada,
    huella: await huellaDe(contenidoFirmado(tipo, registro)),
  };
  await ctx.commit([...cambios, { op: 'set', table: 'certificaciones', id: qcNewId(), patch: cert }, ...firma.extraOps], nota);
  await ctx.reload();
  toast('✅ Firmado.');
  return true;
}

/** Un administrador puede dejar a alguien sin PIN (lo olvidó): vuelve a crear el suyo la próxima vez que firme. */
export async function reiniciarPin(ctx, correo) {
  await ctx.commit([{ op: 'set', table: 'pines', id: idPin(correo), patch: { hash: null, sal: null, firmaDibujada: null, reiniciado: true } }], `PIN de ${correo} reiniciado`);
  await ctx.reload();
}

/** Pestaña "Certificaciones": todas las firmas del proyecto, la más nueva primero. */
export function createCertificacionesTab(ctx) {
  const data = () => ctx.getData();

  function render() {
    const lista = [...data().certificaciones].sort((a, b) => String(b.fechaHora || '').localeCompare(String(a.fechaHora || '')));
    return `
      <section class="qc-card">
        <h3>Certificaciones (${lista.filter((c) => !c.anulado).length})</h3>
        <p class="qc-hint">Cada firma queda con quién, cuándo y qué firmó, y no se puede cambiar ni borrar. Si hubo un error se anula con un motivo y se vuelve a firmar.</p>
        <ul class="qc-people">
          ${lista.map((c) => `
            <li class="qc-person${c.anulado ? ' inactive' : ''}" data-cert="${c.id}">
              <div>
                <strong>${escapeHTML(TIPO_CERT[c.tipo] || c.tipo)} ${escapeHTML(c.refCodigo || '')} · ${escapeHTML(ACCION_CERT[c.accion] || c.accion)}${c.nivel === 2 ? ' (2ª firma)' : ''}</strong>
                <p class="qc-person-meta">${escapeHTML(c.firmanteNombre || c.firmadoPor)}${c.firmanteCargo ? ' · ' + escapeHTML(c.firmanteCargo) : ''} · ${escapeHTML(fechaHora(c.fechaHora))}</p>
                ${c.anulado ? `<p class="qc-person-meta">🚫 Anulada: ${escapeHTML(c.motivoAnulacion || '')}</p>` : ''}
              </div>
              <button type="button" class="icon-btn" data-ver-cert="${c.id}" title="Ver">🔍</button>
            </li>`).join('') || '<li class="empty-state">Todavía no hay certificaciones. Se crean al terminar una actividad, cerrar una observación o aprobar una entrega.</li>'}
        </ul>
      </section>`;
  }

  function bind(container) {
    container.querySelectorAll('[data-ver-cert]').forEach((b) => b.addEventListener('click', () => detalle(b.dataset.verCert)));
  }

  async function detalle(id) {
    const c = data().certificaciones.find((x) => x.id === id);
    if (!c) return;
    const ref = data()[c.refTabla]?.find((x) => x.id === c.refId);
    const hoy = ref ? await huellaDe(contenidoFirmado(c.tipo, ref)) : null;
    const intacto = hoy === c.huella;
    const puedeAnular = !c.anulado && (ctx.isAdmin || ctx.yoSoy()?.rol === 'responsable');
    const ov = abrirModal(`
      <h2>${escapeHTML(TIPO_CERT[c.tipo] || c.tipo)} ${escapeHTML(c.refCodigo || '')} · ${escapeHTML(ACCION_CERT[c.accion] || c.accion)}</h2>
      <dl class="qc-meta">
        <dt>Firmó</dt><dd>${escapeHTML(c.firmanteNombre || '')}${c.firmanteCargo ? ' · ' + escapeHTML(c.firmanteCargo) : ''}</dd>
        <dt>Cuenta</dt><dd>${escapeHTML(c.firmadoPor || '')}</dd>
        <dt>Fecha y hora</dt><dd>${escapeHTML(fechaHora(c.fechaHora))}</dd>
        ${c.nivel === 2 ? '<dt>Tipo</dt><dd>Segunda firma (gobernanza)</dd>' : ''}
        ${c.comentario ? `<dt>Comentario</dt><dd>${escapeHTML(c.comentario)}</dd>` : ''}
        <dt>Huella</dt><dd>${escapeHTML(String(c.huella || '').slice(0, 16))}…</dd>
      </dl>
      ${imagenSegura(c.firmaDibujada) ? `<div class="qc-firma-box"><img src="${imagenSegura(c.firmaDibujada)}" alt="Firma" /></div>` : ''}
      <p class="qc-hint">${ref ? (intacto ? '✅ Lo firmado no ha cambiado desde la firma.' : '⚠️ El contenido cambió después de la firma.') : 'No se encontró el registro firmado.'}</p>
      ${c.anulado ? `<p class="qc-hint">🚫 Anulada: ${escapeHTML(c.motivoAnulacion || '')}</p>` : ''}
      <div class="modal-actions qc-obs-actions">
        ${puedeAnular ? '<button type="button" class="btn btn-secondary" data-acc="anular">🚫 Anular</button>' : ''}
        <button type="button" class="btn btn-primary" data-acc="cerrar">Cerrar</button>
      </div>`);
    ov.addEventListener('click', async (e) => {
      const acc = e.target.closest('[data-acc]')?.dataset.acc;
      if (e.target === ov || acc === 'cerrar') { ov.remove(); return; }
      if (acc !== 'anular') return;
      ov.remove();
      const r = await promptDialog({ title: 'Anular certificación', fields: [{ name: 'motivo', label: 'Motivo (queda en el historial)', type: 'textarea', maxlength: 500 }], confirmLabel: 'Anular' });
      if (!r?.motivo) return;
      const ops = [{ op: 'void', table: 'certificaciones', id: c.id, reason: r.motivo }];
      // Lo certificado vuelve al estado anterior, si todavía estaba como lo dejó esa firma.
      if (ref && c.refTabla === 'actividades' && ref.estado === 'terminada') ops.push({ op: 'set', table: 'actividades', id: ref.id, patch: { estado: 'en_curso', fechaCumplida: null, cumplidaPor: null } });
      if (ref && c.refTabla === 'observaciones' && ref.estado === 'Cerrada') ops.push({ op: 'set', table: 'observaciones', id: ref.id, patch: { estado: ref.respuesta ? 'Respondida' : 'Abierta', fechaCierre: null, verificadaPor: null } });
      if (ref && c.refTabla === 'entregas' && ['Aprobada', 'Recomendada para aprobación'].includes(ref.estado)) {
        ops.push({ op: 'set', table: 'entregas', id: ref.id, patch: c.nivel === 2 ? { estado: 'Recomendada para aprobación', aprobacion2Por: null, fechaAprobacion: null } : { estado: 'En revisión', aprobacion1Por: null, aprobacion2Por: null, fechaAprobacion: null } });
      }
      await ctx.commit(ops, `Certificación de ${c.refCodigo} anulada`);
      await ctx.reload();
      ctx.paint();
    });
  }

  return { render, bind };
}
