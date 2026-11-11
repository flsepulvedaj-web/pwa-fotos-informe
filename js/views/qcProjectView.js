import { getSignedInEmail } from '../googleDrive.js';
import { modulesForEmail, getCachedPermissions } from '../permissions.js';
import { qcLoadProject, qcCommit, qcHistory, qcVerifyChain, qcNewId } from '../qcStore.js';
import { QC_ROLES, roleLabel } from '../qcTemplates.js';
import { ventanaActividad, formatFecha, parsePlazo } from '../qcDates.js';
import { navigate } from '../router.js';
import { promptDialog, toast, escapeHTML } from '../utils.js';

const TABS = [
  { id: 'plan', label: 'Plan de calidad' },
  { id: 'participantes', label: 'Participantes' },
  { id: 'catalogos', label: 'Catálogos' },
  { id: 'historial', label: 'Historial' },
];

const ESTADOS_ACTIVIDAD = [
  { value: 'pendiente', label: 'Pendiente' },
  { value: 'en_curso', label: 'En curso' },
];

const BLOQUEA = [
  { value: 'abiertas', label: 'Bloquea la aprobación mientras esté abierta' },
  { value: 'sin_solucion', label: 'Bloquea hasta que esté corregida o con solución acordada' },
  { value: 'no', label: 'No bloquea la aprobación' },
];

const LISTAS_EDITABLES = [
  { id: 'especialidades', titulo: 'Especialidades', tipo: 'nombre' },
  { id: 'estadosEntrega', titulo: 'Estados de una entrega', tipo: 'texto' },
  { id: 'estadosObservacion', titulo: 'Estados de una observación', tipo: 'texto' },
  { id: 'feriados', titulo: 'Feriados (para los días hábiles)', tipo: 'feriado' },
];

function estadoLabel(value) {
  return ESTADOS_ACTIVIDAD.find((e) => e.value === value)?.label || value;
}

/**
 * Pantalla de un proyecto de Control de calidad. Cada cambio se guarda como un
 * evento (ver js/qcStore.js): nada se borra, lo que no sirve se anula.
 */
export async function renderQcProjectView(container, projectId) {
  const email = await getSignedInEmail();
  const allowed = modulesForEmail(email, getCachedPermissions());
  if (!allowed.includes('calidad')) {
    navigate('/calidad');
    return;
  }

  let data = await qcLoadProject(projectId);
  if (!data.proyecto) {
    toast('No se encontró el proyecto.');
    navigate('/calidad');
    return;
  }

  let tab = 'plan';
  const openStages = new Set();
  let firstPaint = true;

  async function reload() {
    data = await qcLoadProject(projectId);
  }

  async function save(table, id, patch, note) {
    await qcCommit(projectId, [{ op: 'set', table, id, patch }], note);
    await reload();
  }

  const holidays = () => (data.catalogos.feriados || []).map((h) => h.fecha);

  function paint() {
    const scrollY = window.scrollY;
    const p = data.proyecto;
    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver a los proyectos">←</button>
        <span class="header-title">${escapeHTML(p.nombre)}</span>
      </header>
      <nav class="qc-tabs">
        ${TABS.map((t) => `<button type="button" class="qc-tab${t.id === tab ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
      </nav>
      <main class="view-content qc-content" id="qc-content">${renderTab()}</main>
    `;
    container.querySelector('#btn-back').addEventListener('click', () => navigate('/calidad'));
    container.querySelectorAll('.qc-tab').forEach((b) =>
      b.addEventListener('click', async () => {
        tab = b.dataset.tab;
        if (tab === 'historial') historyEvents = await qcHistory(projectId);
        paint();
      })
    );
    bindTab();
    if (!firstPaint) window.scrollTo(0, scrollY);
    firstPaint = false;
  }

  let historyEvents = [];
  let integrity = null;

  function renderTab() {
    if (tab === 'plan') return renderPlan();
    if (tab === 'participantes') return renderParticipantes();
    if (tab === 'catalogos') return renderCatalogos();
    return renderHistorial();
  }

  function bindTab() {
    if (tab === 'plan') bindPlan();
    else if (tab === 'participantes') bindParticipantes();
    else if (tab === 'catalogos') bindCatalogos();
    else bindHistorial();
  }

  // ---------- Plan de calidad ----------

  function renderPlan() {
    const p = data.proyecto;
    const etapas = data.etapas.filter((e) => !e.anulado);
    const meta = [
      ['Código', p.codigo],
      ['Mandante', p.mandante],
      ['Contraparte', p.contraparte],
      ['PML', p.pml],
      ['Diseñador', p.disenador],
      ['Contrato', p.contrato],
      ['Plan', p.versionPlan],
    ].filter(([, v]) => v);

    return `
      <section class="qc-card">
        <div class="qc-card-header">
          <h3>Proyecto</h3>
          <button type="button" class="btn btn-secondary" id="qc-edit-project">✏️ Editar</button>
        </div>
        <dl class="qc-meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHTML(v)}</dd>`).join('')}</dl>
        <label class="qc-inline-field">Inicio del servicio
          <input type="date" id="qc-fecha-inicio" value="${escapeHTML(p.fechaInicio || '')}" />
        </label>
        <p class="qc-hint">Con esta fecha se calculan las actividades que dicen "Primeros 30 días" o "Primera semana".</p>
      </section>
      ${etapas.map((e) => renderStage(e)).join('') || '<div class="empty-state"><p>Este proyecto todavía no tiene etapas.</p></div>'}
    `;
  }

  function renderStage(e) {
    const acts = data.actividades.filter((a) => a.etapaId === e.id && !a.anulado);
    const open = openStages.has(e.id);
    const chips = [e.semana, e.referencia, e.hito].filter(Boolean);
    return `
      <section class="qc-stage" data-stage="${e.id}">
        <button type="button" class="qc-stage-head" data-toggle="${e.id}" aria-expanded="${open}">
          <span class="qc-stage-title"><span class="qc-code">${escapeHTML(e.codigo)}</span> ${escapeHTML(e.nombre)}</span>
          <span class="qc-stage-count">${acts.length} act.</span>
        </button>
        ${open ? `
          <div class="qc-stage-body">
            ${chips.length ? `<p class="qc-chips">${chips.map((c) => `<span class="qc-chip">${escapeHTML(c)}</span>`).join('')}</p>` : ''}
            ${e.plazoRevisionDias != null ? `
              <div class="qc-stage-fields">
                <label class="qc-inline-field">Recepción de la entrega
                  <input type="date" data-stage-date="${e.id}" value="${escapeHTML(e.fechaRecepcion || '')}" />
                </label>
                <label class="qc-inline-field">Plazo de revisión (días hábiles)
                  <input type="number" min="1" max="60" data-stage-days="${e.id}" value="${e.plazoRevisionDias}" />
                </label>
              </div>
              <p class="qc-hint">Al poner la fecha de recepción se calculan los plazos de las actividades en días hábiles, con feriados de Chile.</p>
            ` : ''}
            <ul class="qc-activities">${acts.map((a) => renderActivity(a, e)).join('')}</ul>
          </div>
        ` : ''}
      </section>
    `;
  }

  function renderActivity(a, etapa) {
    const v = ventanaActividad(a, etapa, data.proyecto, holidays());
    const plazo = a.plazoParseado || parsePlazo(a.plazoTexto);
    let vence = '';
    if (v) {
      const rango = v.desde && v.desde !== v.hasta ? `${formatFecha(v.desde)} → ${formatFecha(v.hasta)}` : formatFecha(v.hasta);
      vence = `<span class="qc-due ${v.origen}">${v.origen === 'manual' ? '📌' : '📅'} ${escapeHTML(rango)}</span>`;
    } else if (plazo.tipo === 'evento' || plazo.tipo === 'tabla41') {
      vence = '<span class="qc-due pendiente">Se calcula al registrar la entrega</span>';
    } else {
      vence = '<span class="qc-due pendiente">Sin fecha</span>';
    }
    return `
      <li class="qc-activity" data-activity="${a.id}">
        <div class="qc-activity-top">
          <span class="qc-code">${escapeHTML(a.codigo)}</span>
          <span class="qc-estado qc-estado-${a.estado}">${escapeHTML(estadoLabel(a.estado))}</span>
          <button type="button" class="icon-btn qc-edit-activity" data-edit-activity="${a.id}" title="Editar">✏️</button>
        </div>
        <p class="qc-activity-desc">${escapeHTML(a.descripcion)}</p>
        <p class="qc-activity-meta">
          <span>👤 ${escapeHTML(a.responsableTexto || 'Sin responsable')}</span>
          <span>⏱ ${escapeHTML(a.plazoTexto || '—')}</span>
          ${vence}
        </p>
      </li>
    `;
  }

  function bindPlan() {
    container.querySelector('#qc-edit-project').addEventListener('click', async () => {
      const p = data.proyecto;
      const r = await promptDialog({
        title: 'Editar proyecto',
        fields: [
          { name: 'nombre', label: 'Nombre', value: p.nombre, maxlength: 200 },
          { name: 'codigo', label: 'Código', value: p.codigo || '' },
          { name: 'mandante', label: 'Mandante', value: p.mandante || '' },
          { name: 'contraparte', label: 'Contraparte del mandante', value: p.contraparte || '' },
          { name: 'disenador', label: 'Diseñador o empresa revisada', value: p.disenador || '' },
          { name: 'contrato', label: 'N° de contrato', value: p.contrato || '' },
        ],
      });
      if (!r || !r.nombre) return;
      await save('proyectos', projectId, r, 'Datos del proyecto editados');
      paint();
    });

    container.querySelector('#qc-fecha-inicio').addEventListener('change', async (e) => {
      await save('proyectos', projectId, { fechaInicio: e.target.value || null }, 'Fecha de inicio del servicio');
      paint();
    });

    container.querySelectorAll('[data-toggle]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.toggle;
        if (openStages.has(id)) openStages.delete(id);
        else openStages.add(id);
        paint();
      })
    );

    container.querySelectorAll('[data-stage-date]').forEach((input) =>
      input.addEventListener('change', async () => {
        await save('etapas', input.dataset.stageDate, { fechaRecepcion: input.value || null }, 'Fecha de recepción de la entrega');
        paint();
      })
    );

    container.querySelectorAll('[data-stage-days]').forEach((input) =>
      input.addEventListener('change', async () => {
        const days = Math.max(1, Math.min(60, Number(input.value) || 10));
        await save('etapas', input.dataset.stageDays, { plazoRevisionDias: days }, 'Plazo de revisión de la etapa');
        paint();
      })
    );

    container.querySelectorAll('[data-edit-activity]').forEach((b) =>
      b.addEventListener('click', async () => {
        const a = data.actividades.find((x) => x.id === b.dataset.editActivity);
        const r = await promptDialog({
          title: `Actividad ${a.codigo}`,
          fields: [
            { name: 'estado', label: 'Estado', type: 'select', value: a.estado, options: ESTADOS_ACTIVIDAD },
            { name: 'fechaManual', label: 'Fecha límite puesta a mano (déjala vacía para usar el cálculo)', type: 'date', value: a.fechaManual || '' },
            { name: 'responsableTexto', label: 'Responsable', value: a.responsableTexto || '' },
            { name: 'plazoTexto', label: 'Plazo (texto)', value: a.plazoTexto || '' },
          ],
        });
        if (!r) return;
        const patch = {
          estado: r.estado,
          fechaManual: r.fechaManual || null,
          responsableTexto: r.responsableTexto,
          plazoTexto: r.plazoTexto,
          plazoParseado: parsePlazo(r.plazoTexto),
        };
        await save('actividades', a.id, patch, `Actividad ${a.codigo} editada`);
        paint();
      })
    );
  }

  // ---------- Participantes ----------

  function renderParticipantes() {
    const list = data.participantes.filter((x) => !x.anulado);
    return `
      <section class="qc-card">
        <div class="qc-card-header">
          <h3>Participantes</h3>
          <button type="button" class="btn btn-primary" id="qc-add-participant">➕ Agregar</button>
        </div>
        <p class="qc-hint">Cada rol define lo que la persona puede hacer en este proyecto. El mandante solo puede mirar.</p>
        <ul class="qc-people">
          ${list.map((x) => `
            <li class="qc-person${x.activo === false ? ' inactive' : ''}${x.pendiente ? ' pending' : ''}" data-person="${x.id}">
              <div>
                <strong>${escapeHTML(x.nombre || '(falta el nombre)')}</strong>
                <span class="qc-role-tag">${escapeHTML(roleLabel(x.rol))}</span>
                <p class="qc-person-meta">${escapeHTML([x.cargo, x.empresa, x.correo].filter(Boolean).join(' · ') || 'Sin datos')}</p>
                ${x.activo === false ? '<p class="qc-person-meta">Inactivo</p>' : ''}
              </div>
              <button type="button" class="icon-btn" data-edit-person="${x.id}" title="Editar">✏️</button>
            </li>
          `).join('') || '<li class="empty-state">Todavía no hay participantes.</li>'}
        </ul>
      </section>
    `;
  }

  async function editPerson(existing) {
    const r = await promptDialog({
      title: existing ? 'Editar participante' : 'Nuevo participante',
      fields: [
        { name: 'nombre', label: 'Nombre', value: existing?.nombre || '' },
        { name: 'correo', label: 'Correo de Google', type: 'email', value: existing?.correo || '', maxlength: 120 },
        { name: 'empresa', label: 'Empresa', value: existing?.empresa || '' },
        { name: 'cargo', label: 'Cargo', value: existing?.cargo || '' },
        { name: 'rol', label: 'Rol en el proyecto', type: 'select', value: existing?.rol || 'revisor', options: QC_ROLES.map((x) => ({ value: x.id, label: x.label })) },
        { name: 'activo', label: '¿Sigue participando?', type: 'select', value: existing?.activo === false ? 'no' : 'si', options: [{ value: 'si', label: 'Sí' }, { value: 'no', label: 'No (se conserva el historial)' }] },
      ],
    });
    if (!r || !r.nombre) return;
    const { activo, ...rest } = r;
    const patch = { ...rest, correo: rest.correo.toLowerCase(), activo: activo !== 'no', pendiente: false };
    await save('participantes', existing?.id || qcNewId(), patch, existing ? 'Participante editado' : 'Participante agregado');
    paint();
  }

  function bindParticipantes() {
    container.querySelector('#qc-add-participant').addEventListener('click', () => editPerson(null));
    container.querySelectorAll('[data-edit-person]').forEach((b) =>
      b.addEventListener('click', () => editPerson(data.participantes.find((x) => x.id === b.dataset.editPerson)))
    );
  }

  // ---------- Catálogos ----------

  function listaComoTexto(def, items) {
    if (def.tipo === 'nombre') return items.map((i) => i.nombre).join('\n');
    if (def.tipo === 'feriado') return items.map((i) => `${i.fecha} ${i.nombre || ''}`.trim()).join('\n');
    return items.join('\n');
  }

  function textoComoLista(def, text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (def.tipo === 'nombre') return lines.map((nombre) => ({ nombre }));
    if (def.tipo === 'feriado') {
      return lines
        .map((l) => ({ fecha: l.slice(0, 10), nombre: l.slice(10).trim() }))
        .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.fecha));
    }
    return lines;
  }

  function renderCatalogos() {
    const cats = data.catalogos.categorias || [];
    return `
      <section class="qc-card">
        <h3>Categorías de observación</h3>
        <ul class="qc-people">
          ${cats.map((c, i) => `
            <li class="qc-person">
              <div>
                <strong>${escapeHTML(c.codigo)}. ${escapeHTML(c.nombre)}</strong>
                <p class="qc-person-meta">${escapeHTML(c.descripcion)}</p>
                <p class="qc-person-meta"><em>${escapeHTML(c.tratamiento)}</em></p>
                <p class="qc-person-meta">Regla: ${escapeHTML(BLOQUEA.find((b) => b.value === c.bloquea)?.label || '')}</p>
              </div>
              <button type="button" class="icon-btn" data-edit-cat="${i}" title="Editar">✏️</button>
            </li>
          `).join('')}
        </ul>
      </section>
      ${LISTAS_EDITABLES.map((def) => {
        const items = data.catalogos[def.id] || [];
        const preview = def.tipo === 'nombre' ? items.map((i) => i.nombre) : def.tipo === 'feriado' ? items.map((i) => `${i.fecha}${i.porConfirmar ? ' ⚠️' : ''}`) : items;
        return `
          <section class="qc-card">
            <div class="qc-card-header">
              <h3>${def.titulo}</h3>
              <button type="button" class="btn btn-secondary" data-edit-list="${def.id}">✏️ Editar</button>
            </div>
            <p class="qc-hint">${items.length} elementos</p>
            <p class="qc-chips">${preview.slice(0, def.tipo === 'feriado' ? 6 : 14).map((t) => `<span class="qc-chip">${escapeHTML(t)}</span>`).join('')}${preview.length > 14 && def.tipo !== 'feriado' ? '<span class="qc-chip">…</span>' : ''}${def.tipo === 'feriado' && preview.length > 6 ? '<span class="qc-chip">…</span>' : ''}</p>
          </section>
        `;
      }).join('')}
      ${(data.catalogos.indicadores || []).length ? `
        <section class="qc-card">
          <h3>Indicadores de calidad</h3>
          <ul class="qc-people">${data.catalogos.indicadores.map((i) => `<li class="qc-person"><div><strong>${escapeHTML(i.indicador)}</strong><p class="qc-person-meta">Meta: ${escapeHTML(i.meta)} · Reporte: ${escapeHTML(i.reporte)}</p></div></li>`).join('')}</ul>
        </section>
      ` : ''}
    `;
  }

  function bindCatalogos() {
    container.querySelectorAll('[data-edit-cat]').forEach((b) =>
      b.addEventListener('click', async () => {
        const i = Number(b.dataset.editCat);
        const cats = [...(data.catalogos.categorias || [])];
        const c = cats[i];
        const r = await promptDialog({
          title: `Categoría ${c.codigo}`,
          fields: [
            { name: 'nombre', label: 'Nombre', value: c.nombre },
            { name: 'descripcion', label: 'Descripción', type: 'textarea', value: c.descripcion },
            { name: 'tratamiento', label: 'Tratamiento', type: 'textarea', value: c.tratamiento },
            { name: 'bloquea', label: 'Regla para aprobar', type: 'select', value: c.bloquea, options: BLOQUEA },
          ],
        });
        if (!r) return;
        cats[i] = { ...c, ...r };
        await save('catalogos', 'categorias', { items: cats }, `Categoría ${c.codigo} editada`);
        paint();
      })
    );

    container.querySelectorAll('[data-edit-list]').forEach((b) =>
      b.addEventListener('click', async () => {
        const def = LISTAS_EDITABLES.find((d) => d.id === b.dataset.editList);
        const hint = def.tipo === 'feriado' ? ' (una por línea: AAAA-MM-DD nombre)' : ' (uno por línea)';
        const r = await promptDialog({
          title: def.titulo,
          fields: [{ name: 'texto', label: `Lista${hint}`, type: 'textarea', value: listaComoTexto(def, data.catalogos[def.id] || []), maxlength: 6000 }],
        });
        if (!r) return;
        await save('catalogos', def.id, { items: textoComoLista(def, r.texto) }, `${def.titulo} editado`);
        paint();
      })
    );
  }

  // ---------- Historial ----------

  function renderHistorial() {
    const fmt = (ts) => new Date(ts).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });
    return `
      <section class="qc-card">
        <div class="qc-card-header">
          <h3>Historial de cambios</h3>
          <button type="button" class="btn btn-secondary" id="qc-verify">🔍 Verificar integridad</button>
        </div>
        <p class="qc-hint">Cada cambio queda registrado con quién y cuándo, y no se puede editar ni borrar. Si alguien altera un registro antiguo, la verificación lo detecta.</p>
        ${integrity ? `<p class="qc-integrity ${integrity.ok ? 'ok' : 'bad'}">${integrity.ok ? `✅ Todo en orden: ${integrity.total} cambios verificados.` : `⚠️ Se detectaron ${integrity.problemas.length} registros alterados o faltantes.`}</p>` : ''}
        <ul class="qc-history">
          ${historyEvents.map((e) => `
            <li>
              <span class="qc-history-when">${escapeHTML(fmt(e.ts))}</span>
              <span class="qc-history-note">${escapeHTML(e.note || 'Cambio')}</span>
              <span class="qc-history-who">${escapeHTML(e.author)} · ${e.ops.length} registro${e.ops.length === 1 ? '' : 's'}</span>
            </li>
          `).join('')}
        </ul>
      </section>
    `;
  }

  function bindHistorial() {
    container.querySelector('#qc-verify').addEventListener('click', async () => {
      integrity = await qcVerifyChain(projectId);
      paint();
    });
  }

  paint();
}
