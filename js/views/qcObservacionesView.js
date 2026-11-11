import { escapeHTML, toast, promptDialog } from '../utils.js';
import { formatFecha } from '../qcDates.js';
import { hoyISO, ordenarEntregas } from '../qcEntregas.js';
import { qcNewId } from '../qcStore.js';
import {
  ESTADO_OBS,
  ORDEN_ESTADOS_OBS,
  MAX_ADJUNTOS,
  permisosObservaciones,
  siguienteNumero,
  numerosARenumerar,
  fotoComoAdjunto,
  categoriaInfo,
  nombreItem,
} from '../qcObservaciones.js';

/** Solo se muestran fotos que sean realmente una imagen en base64 (los datos pueden venir de otro aparato). */
const imagenSegura = (d) => (typeof d === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d) ? d : '');

/**
 * Pestaña "Observaciones" de un proyecto de Control de calidad: matriz filtrable,
 * kanban por estado, formulario para crear, responder y cerrar. Todo cambio se
 * guarda como evento a través de `ctx.save` / `ctx.commit` (nada se borra).
 *
 * ctx: { getData, save, commit, paint, email, miCorreo, isAdmin, yoSoy, nombreDe }
 */
export function createObservacionesTab(ctx) {
  let vista = 'matriz';
  const filtros = { entrega: '', especialidad: '', categoria: '', estado: '', texto: '' };
  let reconciliando = false;

  const data = () => ctx.getData();
  const perms = () => permisosObservaciones(ctx.yoSoy()?.rol || null, ctx.isAdmin);
  const entregasVivas = () => data().entregas.filter((e) => !e.anulado);

  function etiquetaEntrega(entregaId) {
    const e = data().entregas.find((x) => x.id === entregaId);
    if (!e) return 'Sin entrega';
    const et = data().etapas.find((x) => x.id === e.etapaId);
    return `${et ? 'Etapa ' + et.codigo : 'Etapa'} · ${e.version || 'entrega'}`;
  }

  function filtradas() {
    const t = filtros.texto.trim().toLowerCase();
    return data()
      .observaciones.filter((o) => !o.anulado)
      .filter((o) => (!filtros.entrega || o.entregaId === filtros.entrega) && (!filtros.especialidad || o.especialidad === filtros.especialidad) && (!filtros.categoria || o.categoria === filtros.categoria) && (!filtros.estado || o.estado === filtros.estado))
      .filter((o) => !t || [o.texto, o.documento, o.referencia, o.respuesta, String(o.numero)].some((v) => String(v || '').toLowerCase().includes(t)))
      .sort((a, b) => (Number(a.numero) || 0) - (Number(b.numero) || 0));
  }

  function badgeCategoria(codigo) {
    const info = categoriaInfo(data().catalogos, codigo);
    return `<span class="qc-cat qc-cat-${escapeHTML(String(codigo || '').toLowerCase())}" title="${escapeHTML(info.nombre)}">${escapeHTML(codigo || '?')}</span>`;
  }

  function tarjeta(o) {
    const fotos = (o.adjuntos || []).length;
    return `
      <button type="button" class="qc-obs" data-obs="${o.id}">
        <span class="qc-obs-top">
          <span class="qc-obs-num">N° ${escapeHTML(String(o.numero ?? '?'))}</span>
          ${badgeCategoria(o.categoria)}
          <span class="qc-estado qc-obs-estado-${ORDEN_ESTADOS_OBS.indexOf(o.estado)}">${escapeHTML(o.estado || '')}</span>
          ${fotos ? `<span class="qc-obs-fotos">📎 ${fotos}</span>` : ''}
        </span>
        <span class="qc-obs-text">${escapeHTML(o.texto || '')}</span>
        <span class="qc-obs-meta">${escapeHTML([o.especialidad, o.documento, etiquetaEntrega(o.entregaId)].filter(Boolean).join(' · '))}</span>
        ${o.renumerada ? `<span class="qc-obs-meta">⚠️ El N° cambió de ${escapeHTML(String(o.numeroOriginal))} a ${escapeHTML(String(o.numero))} (dos personas la crearon a la vez).</span>` : ''}
      </button>`;
  }

  function render() {
    const d = data();
    const p = perms();
    const todas = d.observaciones.filter((o) => !o.anulado);
    const lista = filtradas();
    const opt = (valor, etiqueta, sel) => `<option value="${escapeHTML(valor)}"${sel === valor ? ' selected' : ''}>${escapeHTML(etiqueta)}</option>`;
    const entregas = ordenarEntregas(entregasVivas());
    const especialidades = (d.catalogos.especialidades || []).map(nombreItem).filter(Boolean);
    const categorias = d.catalogos.categorias || [];

    const matriz = lista.length ? `<div class="qc-obs-list">${lista.map(tarjeta).join('')}</div>` : `<p class="qc-hint">${todas.length ? 'Ninguna observación coincide con los filtros.' : 'Todavía no hay observaciones.'}</p>`;
    const kanban = `<div class="qc-kanban">${ORDEN_ESTADOS_OBS.map((estado) => {
      const col = lista.filter((o) => o.estado === estado);
      return `<div class="qc-kanban-col"><h4>${escapeHTML(estado)} <span>${col.length}</span></h4>${col.map(tarjeta).join('') || '<p class="qc-hint">—</p>'}</div>`;
    }).join('')}</div>`;

    return `
      <section class="qc-card">
        <div class="qc-card-header">
          <h3>Observaciones (${todas.length})</h3>
          ${p.crear ? '<button type="button" class="btn btn-primary" id="qc-new-obs">➕ Nueva</button>' : ''}
        </div>
        ${p.soloLectura ? '<p class="qc-hint">Solo puedes mirar: tu cuenta no tiene un rol que pueda crear o responder observaciones en este proyecto.</p>' : ''}
        <div class="qc-obs-tools">
          <div class="qc-seg">
            <button type="button" class="qc-seg-btn${vista === 'matriz' ? ' active' : ''}" data-vista="matriz">Matriz</button>
            <button type="button" class="qc-seg-btn${vista === 'kanban' ? ' active' : ''}" data-vista="kanban">Kanban</button>
          </div>
        </div>
        <div class="qc-filters">
          <select data-filtro="entrega" aria-label="Entrega">${opt('', 'Todas las entregas', filtros.entrega)}${entregas.map((e) => opt(e.id, etiquetaEntrega(e.id), filtros.entrega)).join('')}</select>
          <select data-filtro="especialidad" aria-label="Especialidad">${opt('', 'Todas las especialidades', filtros.especialidad)}${especialidades.map((n) => opt(n, n, filtros.especialidad)).join('')}</select>
          <select data-filtro="categoria" aria-label="Categoría">${opt('', 'Todas las categorías', filtros.categoria)}${categorias.map((c) => opt(c.codigo, `${c.codigo} · ${c.nombre}`, filtros.categoria)).join('')}</select>
          <select data-filtro="estado" aria-label="Estado">${opt('', 'Todos los estados', filtros.estado)}${ORDEN_ESTADOS_OBS.map((e) => opt(e, e, filtros.estado)).join('')}</select>
          <input type="search" data-filtro="texto" placeholder="Buscar en el texto…" value="${escapeHTML(filtros.texto)}" />
        </div>
      </section>
      ${vista === 'kanban' ? kanban : `<section class="qc-card">${matriz}</section>`}
    `;
  }

  function bind(container) {
    container.querySelector('#qc-new-obs')?.addEventListener('click', () => formularioObservacion(null));
    container.querySelectorAll('[data-vista]').forEach((b) => b.addEventListener('click', () => { vista = b.dataset.vista; ctx.paint(); }));
    container.querySelectorAll('[data-filtro]').forEach((el) => {
      const evento = el.tagName === 'INPUT' ? 'change' : 'change';
      el.addEventListener(evento, () => {
        filtros[el.dataset.filtro] = el.value;
        ctx.paint();
      });
    });
    container.querySelectorAll('[data-obs]').forEach((b) => b.addEventListener('click', () => detalle(b.dataset.obs)));
  }

  // ---------- Ventanas ----------

  function abrirModal(html) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal qc-obs-modal" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  function ampliarFoto(src) {
    const seguro = imagenSegura(src);
    if (!seguro) return;
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<img src="${seguro}" alt="Foto adjunta" class="qc-lightbox" />`;
    ov.addEventListener('click', () => ov.remove());
    document.body.appendChild(ov);
  }

  /**
   * Formulario de observación. Con `existente` edita; sin él crea una nueva.
   * Las fotos se reducen y viajan dentro del propio evento (offline-first).
   */
  function formularioObservacion(existente) {
    const d = data();
    const entregas = ordenarEntregas(entregasVivas()).filter((e) => e.estado !== 'Devuelta (incompleta)');
    if (!existente && !entregas.length) {
      toast('Primero registra una entrega en la pestaña Entregas: las observaciones se asocian a una entrega.');
      return;
    }
    const especialidades = (d.catalogos.especialidades || []).map(nombreItem).filter(Boolean);
    const categorias = d.catalogos.categorias || [];
    const entregaActual = existente?.entregaId || entregas[entregas.length - 1]?.id;
    let adjuntos = [...(existente?.adjuntos || [])];

    const sel = (name, items, valor, vacio) => `<select name="${name}">${vacio ? `<option value="">${escapeHTML(vacio)}</option>` : ''}${items.map((i) => `<option value="${escapeHTML(i.value)}"${i.value === valor ? ' selected' : ''}>${escapeHTML(i.label)}</option>`).join('')}</select>`;

    const ov = abrirModal(`
      <h2>${existente ? `Observación N° ${escapeHTML(String(existente.numero))}` : 'Nueva observación'}</h2>
      <label>Entrega revisada ${sel('entregaId', (existente ? entregasVivas() : entregas).map((e) => ({ value: e.id, label: etiquetaEntrega(e.id) })), entregaActual)}</label>
      <label>Categoría ${sel('categoria', categorias.map((c) => ({ value: c.codigo, label: `${c.codigo} · ${c.nombre}` })), existente?.categoria || categorias[categorias.length - 1]?.codigo)}</label>
      <label>Especialidad ${sel('especialidad', especialidades.map((n) => ({ value: n, label: n })), existente?.especialidad || '', '— sin especialidad —')}</label>
      <label>Documento o plano <input type="text" name="documento" maxlength="200" value="${escapeHTML(existente?.documento || '')}" placeholder="Ej: Plano A-102" /></label>
      <label>Observación <textarea name="texto" rows="4" maxlength="2000" placeholder="Qué está mal o falta">${escapeHTML(existente?.texto || '')}</textarea></label>
      <label>Requisito o referencia <input type="text" name="referencia" maxlength="300" value="${escapeHTML(existente?.referencia || '')}" placeholder="Ej: Anexo F, OGUC art. 4.3.2" /></label>
      <div class="qc-fotos"><div class="qc-fotos-lista" id="obs-fotos"></div>
        <button type="button" class="btn btn-secondary" id="obs-add-foto">📷 Agregar foto</button>
        <input type="file" id="obs-file" accept="image/*" multiple hidden />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancelar</button>
        <button type="button" class="btn btn-primary" data-act="ok">${existente ? 'Guardar' : 'Crear'}</button>
      </div>`);

    const pintarFotos = () => {
      ov.querySelector('#obs-fotos').innerHTML = adjuntos.map((a, i) => `<span class="qc-foto"><img src="${imagenSegura(a.data)}" alt="" /><button type="button" data-quitar="${i}" title="Quitar">✕</button></span>`).join('');
      ov.querySelectorAll('[data-quitar]').forEach((b) => b.addEventListener('click', () => { adjuntos.splice(Number(b.dataset.quitar), 1); pintarFotos(); }));
    };
    pintarFotos();
    ov.querySelector('#obs-add-foto').addEventListener('click', () => ov.querySelector('#obs-file').click());
    ov.querySelector('#obs-file').addEventListener('change', async (e) => {
      for (const f of [...e.target.files]) {
        if (adjuntos.length >= MAX_ADJUNTOS) { toast(`Máximo ${MAX_ADJUNTOS} fotos por observación.`); break; }
        try { adjuntos.push(await fotoComoAdjunto(f)); } catch { toast('No se pudo leer una de las fotos.'); }
      }
      e.target.value = '';
      pintarFotos();
    });
    ov.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'cancel') { ov.remove(); return; }
      const v = (n) => ov.querySelector(`[name="${n}"]`).value.trim();
      if (!v('texto')) { toast('Escribe la observación.'); return; }
      const patch = { entregaId: v('entregaId'), categoria: v('categoria'), especialidad: v('especialidad'), documento: v('documento'), texto: v('texto'), referencia: v('referencia'), adjuntos };
      ov.remove();
      if (existente) {
        await ctx.save('observaciones', existente.id, patch, `Observación N° ${existente.numero} editada`);
      } else {
        const numero = siguienteNumero(data().observaciones);
        await ctx.save('observaciones', qcNewId(), { ...patch, numero, estado: ESTADO_OBS.abierta, creadaPor: ctx.miCorreo || null, fechaCreacion: hoyISO(), solucionAcordada: false }, `Observación N° ${numero} creada`);
        toast(`Observación N° ${numero} creada.`);
      }
      ctx.paint();
    });
  }

  /** Respuesta del revisado: texto y fotos de la corrección. */
  function formularioRespuesta(o) {
    let adjuntos = [...(o.adjuntosRespuesta || [])];
    const ov = abrirModal(`
      <h2>Responder N° ${escapeHTML(String(o.numero))}</h2>
      <p class="modal-message">${escapeHTML(o.texto || '')}</p>
      <label>Respuesta <textarea name="respuesta" rows="4" maxlength="2000" placeholder="Qué se corrigió y dónde">${escapeHTML(o.respuesta || '')}</textarea></label>
      <div class="qc-fotos"><div class="qc-fotos-lista" id="obs-fotos"></div>
        <button type="button" class="btn btn-secondary" id="obs-add-foto">📷 Adjuntar corrección</button>
        <input type="file" id="obs-file" accept="image/*" multiple hidden />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancelar</button>
        <button type="button" class="btn btn-primary" data-act="ok">Enviar respuesta</button>
      </div>`);
    const pintarFotos = () => {
      ov.querySelector('#obs-fotos').innerHTML = adjuntos.map((a, i) => `<span class="qc-foto"><img src="${imagenSegura(a.data)}" alt="" /><button type="button" data-quitar="${i}" title="Quitar">✕</button></span>`).join('');
      ov.querySelectorAll('[data-quitar]').forEach((b) => b.addEventListener('click', () => { adjuntos.splice(Number(b.dataset.quitar), 1); pintarFotos(); }));
    };
    pintarFotos();
    ov.querySelector('#obs-add-foto').addEventListener('click', () => ov.querySelector('#obs-file').click());
    ov.querySelector('#obs-file').addEventListener('change', async (e) => {
      for (const f of [...e.target.files]) {
        if (adjuntos.length >= MAX_ADJUNTOS) { toast(`Máximo ${MAX_ADJUNTOS} fotos.`); break; }
        try { adjuntos.push(await fotoComoAdjunto(f)); } catch { toast('No se pudo leer una de las fotos.'); }
      }
      e.target.value = '';
      pintarFotos();
    });
    ov.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'cancel') { ov.remove(); return; }
      const respuesta = ov.querySelector('[name="respuesta"]').value.trim();
      if (!respuesta && !adjuntos.length) { toast('Escribe la respuesta o adjunta una foto.'); return; }
      ov.remove();
      await ctx.save('observaciones', o.id, { respuesta, adjuntosRespuesta: adjuntos, estado: ESTADO_OBS.respondida, fechaRespuesta: hoyISO(), respondidaPor: ctx.miCorreo || null }, `Observación N° ${o.numero} respondida`);
      toast('Respuesta enviada.');
      ctx.paint();
    });
  }

  function detalle(id) {
    const o = data().observaciones.find((x) => x.id === id);
    if (!o) return;
    const p = perms();
    const esAutor = !!ctx.miCorreo && o.creadaPor === ctx.miCorreo;
    const info = categoriaInfo(data().catalogos, o.categoria);
    const cerrada = o.estado === ESTADO_OBS.cerrada;
    const puedeEditar = (p.editar || (esAutor && p.crear)) && !cerrada;
    const fotos = (arr) => (arr || []).map((a, i) => `<img class="qc-thumb" data-foto="${escapeHTML(a.id)}" src="${imagenSegura(a.data)}" alt="Foto ${i + 1}" />`).join('');
    const fila = (k, v) => (v ? `<dt>${k}</dt><dd>${escapeHTML(v)}</dd>` : '');

    const botones = [
      puedeEditar ? ['editar', '✏️ Editar'] : null,
      p.responder && !cerrada ? ['responder', '💬 Responder'] : null,
      p.cerrar && o.estado === ESTADO_OBS.respondida ? ['verificacion', '🔎 Pasar a verificación'] : null,
      p.cerrar && info.bloquea === 'sin_solucion' && !cerrada && !o.solucionAcordada ? ['solucion', '🤝 Solución acordada'] : null,
      p.cerrar && !cerrada ? ['cerrar', '✅ Verificar y cerrar'] : null,
      p.reabrir && o.estado !== ESTADO_OBS.abierta ? ['reabrir', '↩️ Reabrir'] : null,
      p.anular ? ['anular', '🚫 Anular'] : null,
    ].filter(Boolean);

    const ov = abrirModal(`
      <h2>N° ${escapeHTML(String(o.numero ?? '?'))} ${badgeCategoria(o.categoria)} <span class="qc-estado">${escapeHTML(o.estado || '')}</span></h2>
      <p class="qc-obs-full">${escapeHTML(o.texto || '')}</p>
      <dl class="qc-meta">
        ${fila('Entrega', etiquetaEntrega(o.entregaId))}
        ${fila('Categoría', `${o.categoria || ''} · ${info.nombre}`)}
        ${fila('Especialidad', o.especialidad)}
        ${fila('Documento', o.documento)}
        ${fila('Referencia', o.referencia)}
        ${fila('Creada', o.fechaCreacion ? `${formatFecha(o.fechaCreacion)} por ${ctx.nombreDe(o.creadaPor)}` : '')}
        ${o.solucionAcordada ? fila('Solución', 'Acordada') : ''}
      </dl>
      ${(o.adjuntos || []).length ? `<div class="qc-fotos-lista">${fotos(o.adjuntos)}</div>` : ''}
      ${o.respuesta || (o.adjuntosRespuesta || []).length ? `
        <h3>Respuesta del revisado</h3>
        <p class="qc-obs-full">${escapeHTML(o.respuesta || '')}</p>
        <p class="qc-hint">${escapeHTML([o.fechaRespuesta ? formatFecha(o.fechaRespuesta) : '', o.respondidaPor ? 'por ' + ctx.nombreDe(o.respondidaPor) : ''].filter(Boolean).join(' '))}</p>
        <div class="qc-fotos-lista">${fotos(o.adjuntosRespuesta)}</div>` : ''}
      ${cerrada ? `<p class="qc-hint">✅ Cerrada el ${escapeHTML(formatFecha(o.fechaCierre || ''))}${o.verificadaPor ? ' · verificada por ' + escapeHTML(ctx.nombreDe(o.verificadaPor)) : ''}</p>` : ''}
      ${o.motivoReapertura ? `<p class="qc-hint">↩️ Última reapertura: ${escapeHTML(o.motivoReapertura)}</p>` : ''}
      <div class="modal-actions qc-obs-actions">
        ${botones.map(([id, etiqueta]) => `<button type="button" class="btn btn-secondary" data-acc="${id}">${etiqueta}</button>`).join('')}
        <button type="button" class="btn btn-primary" data-acc="cerrar-ventana">Cerrar ventana</button>
      </div>`);

    ov.querySelectorAll('[data-foto]').forEach((img) => img.addEventListener('click', () => ampliarFoto(img.getAttribute('src'))));
    ov.addEventListener('click', async (e) => {
      if (e.target === ov) { ov.remove(); return; }
      const acc = e.target.closest('[data-acc]')?.dataset.acc;
      if (!acc) return;
      ov.remove();
      const nota = (t) => `Observación N° ${o.numero} ${t}`;
      if (acc === 'cerrar-ventana') return;
      if (acc === 'editar') return formularioObservacion(o);
      if (acc === 'responder') return formularioRespuesta(o);
      if (acc === 'verificacion') await ctx.save('observaciones', o.id, { estado: ESTADO_OBS.verificacion }, nota('en verificación'));
      else if (acc === 'solucion') await ctx.save('observaciones', o.id, { solucionAcordada: true }, nota('con solución acordada'));
      else if (acc === 'cerrar') await ctx.save('observaciones', o.id, { estado: ESTADO_OBS.cerrada, fechaCierre: hoyISO(), verificadaPor: ctx.miCorreo || null }, nota('verificada y cerrada'));
      else if (acc === 'reabrir') {
        const r = await promptDialog({ title: `Reabrir N° ${o.numero}`, fields: [{ name: 'motivo', label: 'Por qué la corrección no resuelve la observación', type: 'textarea', maxlength: 500 }], confirmLabel: 'Reabrir' });
        if (!r?.motivo) return;
        await ctx.save('observaciones', o.id, { estado: ESTADO_OBS.abierta, fechaCierre: null, verificadaPor: null, motivoReapertura: r.motivo }, nota('reabierta'));
      } else if (acc === 'anular') {
        const r = await promptDialog({ title: `Anular N° ${o.numero}`, fields: [{ name: 'motivo', label: 'Motivo (queda en el historial; la observación no se borra)', type: 'textarea', maxlength: 500 }], confirmLabel: 'Anular' });
        if (!r?.motivo) return;
        await ctx.commit([{ op: 'void', table: 'observaciones', id: o.id, reason: r.motivo }], nota('anulada'));
        await ctx.reload();
      }
      ctx.paint();
    });
  }

  /** Corrige números repetidos (dos personas crearon sin conexión a la vez). Todos los aparatos calculan lo mismo. */
  async function reconciliar() {
    if (reconciliando || perms().soloLectura) return;
    const cambios = numerosARenumerar(data().observaciones);
    if (!cambios.length) return;
    reconciliando = true;
    try {
      await ctx.commit(cambios.map((c) => ({ op: 'set', table: 'observaciones', id: c.id, patch: { numero: c.numero, numeroOriginal: c.numeroOriginal, renumerada: true } })), 'Observaciones renumeradas (N° repetido)');
      await ctx.reload();
      ctx.paint();
    } finally {
      reconciliando = false;
    }
  }

  return { render, bind, reconciliar };
}
