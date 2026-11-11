import { getSignedInEmail } from '../googleDrive.js';
import { modulesForEmail, getCachedPermissions, isAdmin, isOwner } from '../permissions.js';
import { qcLoadProject, qcCommit, qcHistory, qcVerifyChain, qcNewId } from '../qcStore.js';
import { QC_ROLES, roleLabel } from '../qcTemplates.js';
import { ventanaActividad, formatFecha, parsePlazo, addCalendarDays, businessDaysBetween } from '../qcDates.js';
import { createObservacionesTab } from './qcObservacionesView.js';
import { certificar, createCertificacionesTab, reiniciarPin } from './qcFirmaView.js';
import { tienePin, idPin, guardarCachePin } from '../qcFirma.js';
import { qcSyncProject, onQcChange } from '../qcSync.js';
import { ESTADO_ENTREGA, hoyISO, ordenarEntregas, venceEntrega, entregaVencida, etapaEfectiva, observacionesBloqueantes } from '../qcEntregas.js';
import { navigate } from '../router.js';
import { promptDialog, toast, escapeHTML, confirmDialog } from '../utils.js';

const TABS = [
  { id: 'tablero', label: 'Tablero' },
  { id: 'plan', label: 'Plan de calidad' },
  { id: 'entregas', label: 'Entregas' },
  { id: 'observaciones', label: 'Observaciones' },
  { id: 'certificaciones', label: 'Certificaciones' },
  { id: 'participantes', label: 'Participantes' },
  { id: 'catalogos', label: 'Catálogos' },
  { id: 'historial', label: 'Historial' },
];

const ESTADOS_ACTIVIDAD = [
  { value: 'pendiente', label: 'Pendiente' },
  { value: 'en_curso', label: 'En curso' },
  { value: 'terminada', label: 'Completada' },
  { value: 'no_aplica', label: 'No aplica' },
];

const BLOQUEA = [
  { value: 'abiertas', label: 'Bloquea la aprobación mientras esté abierta' },
  { value: 'sin_solucion', label: 'Bloquea hasta que esté corregida o con solución acordada' },
  { value: 'no', label: 'No bloquea la aprobación' },
];

const LISTAS_EDITABLES = [
  { id: 'especialidades', titulo: 'Especialidades', tipo: 'nombre' },
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

  let tab = 'tablero';
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
      <main class="view-content qc-content" id="qc-content">${renderQuienSoy()}${renderTab()}</main>
    `;
    container.querySelector('#btn-back').addEventListener('click', () => navigate(p.obraId ? `/control/obra/${p.obraId}/calidad` : '/calidad'));
    container.querySelectorAll('.qc-tab').forEach((b) =>
      b.addEventListener('click', async () => {
        tab = b.dataset.tab;
        if (tab === 'historial') historyEvents = await qcHistory(projectId);
        paint();
      })
    );
    bindTab();
    if (tab === 'observaciones') obsTab.reconciliar();
    if (!firstPaint) window.scrollTo(0, scrollY);
    firstPaint = false;
  }

  let historyEvents = [];
  let integrity = null;

  function renderTab() {
    if (tab === 'tablero') return renderTablero();
    if (tab === 'plan') return renderPlan();
    if (tab === 'entregas') return renderEntregas();
    if (tab === 'observaciones') return obsTab.render();
    if (tab === 'certificaciones') return certTab.render();
    if (tab === 'participantes') return renderParticipantes();
    if (tab === 'catalogos') return renderCatalogos();
    return renderHistorial();
  }

  function bindTab() {
    if (tab === 'tablero') bindTablero();
    else if (tab === 'entregas') bindEntregas();
    else if (tab === 'observaciones') obsTab.bind(container);
    else if (tab === 'certificaciones') certTab.bind(container);
    else if (tab === 'plan') bindPlan();
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
          <div class="qc-card-actions">
            ${isOwner(email) ? '<button type="button" class="btn btn-secondary" id="qc-delete-project" title="Eliminar este proyecto (solo el dueño de la cuenta)">🗑️ Eliminar</button>' : ''}
            <button type="button" class="btn btn-secondary" id="qc-edit-project">✏️ Editar</button>
          </div>
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

  const entregasDe = (etapaId) => data.entregas.filter((x) => x.etapaId === etapaId && !x.anulado);
  const etapaEf = (e) => etapaEfectiva(e, entregasDe(e.id));

  function renderStage(e) {
    const ee = etapaEf(e);
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
              <p class="qc-hint">${ee.fechaRecepcionReal
                ? `📌 Se usa la fecha real de la entrega (${formatFecha(ee.fechaRecepcion)}), registrada en la pestaña Entregas.`
                : 'Al poner la fecha de recepción se calculan los plazos de las actividades en días hábiles, con feriados de Chile.'}</p>
            ` : ''}
            <ul class="qc-activities">${acts.map((a) => renderActivity(a, ee)).join('')}</ul>
          </div>
        ` : ''}
      </section>
    `;
  }

  const miCorreo = (email || '').toLowerCase();
  const personas = () => data.participantes.filter((x) => !x.anulado && x.activo !== false);
  const nombreDe = (correo) => personas().find((x) => (x.correo || '').toLowerCase() === (correo || '').toLowerCase())?.nombre || correo || '';

  /** La persona del proyecto que corresponde a la cuenta de Google con la que se entró. */
  const yoSoy = () => (miCorreo ? personas().find((x) => (x.correo || '').toLowerCase() === miCorreo) : null);

  // Si esta persona ya tiene PIN y firma en este proyecto, este aparato los recuerda
  // para reutilizarlos en otros proyectos sin crearlos de nuevo.
  guardarCachePin(miCorreo, data.pines.find((p) => p.id === idPin(miCorreo) && !p.anulado));

  // Lo que necesitan las pantallas de observaciones y de firma.
  const firmaCtx = {
    getData: () => data,
    save,
    commit: (ops, note) => qcCommit(projectId, ops, note),
    reload,
    paint: () => paint(),
    email,
    miCorreo,
    isAdmin: isAdmin(email),
    yoSoy,
    nombreDe,
  };
  const obsTab = createObservacionesTab({
    ...firmaCtx,
    certificar: (args) => certificar(firmaCtx, args),
    exportarExcel: async () => {
      try {
        const { exportarExcel } = await import('../qcExport.js');
        toast(`📊 Excel listo: ${exportarExcel(data, nombreDe)}`);
      } catch (err) {
        console.error(err);
        toast(err.message || 'No se pudo generar el Excel.');
      }
    },
  });

  async function generarInforme(entregaId) {
    try {
      toast('Armando el informe…');
      const { construirInformePDF } = await import('../qcInformePdf.js');
      const { downloadBlob, sanitizeFilename } = await import('../pdfExport.js');
      const x = data.entregas.find((e) => e.id === entregaId);
      const etapa = data.etapas.find((e) => e.id === x.etapaId);
      const blob = construirInformePDF(data, entregaId, nombreDe, holidays());
      downloadBlob(blob, `Informe de revision - ${sanitizeFilename(data.proyecto.nombre).slice(0, 50)} - Etapa ${etapa?.codigo || ''} ${x.version || ''}.pdf`);
    } catch (err) {
      console.error(err);
      toast('No se pudo armar el informe.');
    }
  }
  const certTab = createCertificacionesTab(firmaCtx);

  function renderQuienSoy() {
    const yo = yoSoy();
    if (yo) {
      return `<p class="qc-whoami ok">👤 Entraste como <strong>${escapeHTML(yo.nombre || email)}</strong>${yo.cargo ? ' · ' + escapeHTML(yo.cargo) : ''} <span>(${escapeHTML(roleLabel(yo.rol))})</span></p>`;
    }
    if (isAdmin(email)) {
      return `<p class="qc-whoami">👤 Entraste como administrador (${escapeHTML(email)}). Para que la app te reconozca con tu cargo, pon tu correo en <strong>Participantes</strong>.</p>`;
    }
    return `<p class="qc-whoami warn">⚠️ Tu cuenta (${escapeHTML(email || 'sin sesión')}) no está en la lista de participantes de este proyecto. Solo podrás mirar.</p>`;
  }

  /** Persona responsable de una actividad: la elegida a mano o, si no hay, la
   * que tiene ese cargo en el proyecto. */
  function personaDe(a) {
    if (a.responsableId) return personas().find((x) => x.id === a.responsableId) || null;
    // Por cargo, sin importar mayúsculas ni tildes, y aceptando que uno sea
    // el comienzo del otro ("Asistente Técnico" = "Asistente Técnico de Proyecto").
    const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const buscado = norm(a.responsableTexto);
    if (!buscado) return null;
    const conCargo = personas().filter((x) => x.cargo);
    return (
      conCargo.find((x) => norm(x.cargo) === buscado) ||
      conCargo.find((x) => norm(x.cargo).startsWith(buscado) || buscado.startsWith(norm(x.cargo))) ||
      null
    );
  }

  /** Solo la persona responsable (por su correo de Google) o un administrador
   * puede cambiar el estado de una actividad. */
  function puedeActuar(a) {
    if (isAdmin(email)) return { ok: true };
    const p = personaDe(a);
    if (!p) return { ok: false, msg: 'Esta actividad no tiene una persona responsable asignada. Pídele a un administrador que la asigne.' };
    if (!p.correo) return { ok: false, msg: `Falta el correo de ${p.nombre || p.cargo} en Participantes: sin eso no se sabe quién es.` };
    if (p.correo.toLowerCase() !== miCorreo) return { ok: false, msg: `Solo ${p.nombre || p.cargo} (responsable) puede cambiar esta actividad.` };
    return { ok: true };
  }

  /** Lista para el desplegable "Responsable": los cargos de los participantes
   * del proyecto y los que ya aparecen en las actividades del plan. */
  function opcionesResponsable(a) {
    const actual = personaDe(a);
    const opts = personas().map((x) => ({ value: x.id, label: [x.nombre || '(sin nombre)', x.cargo].filter(Boolean).join(' — ') + (x.correo ? '' : ' · falta correo') }));
    return [{ value: '', label: 'Sin responsable' }, ...opts, ...(a.responsableTexto && !actual ? [{ value: '__texto', label: `${a.responsableTexto} (sin persona asignada)` }] : [])];
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
    } else if (plazo.tipo === 'inicio') {
      vence = '<span class="qc-due pendiente">Sin fecha: falta el inicio del servicio (arriba, en Plan de calidad)</span>';
    } else if (plazo.tipo === 'recepcion' || plazo.tipo === 'paralelo') {
      vence = '<span class="qc-due pendiente">Sin fecha: falta registrar la entrega de esta etapa</span>';
    } else {
      vence = '<span class="qc-due pendiente">Sin fecha: se pone a mano (✏️)</span>';
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
          <span>👤 ${escapeHTML(personaDe(a) ? [personaDe(a).nombre, personaDe(a).cargo].filter(Boolean).join(' · ') : (a.responsableTexto ? a.responsableTexto + ' (sin persona asignada)' : 'Sin responsable'))}</span>
          <span>⏱ ${escapeHTML(a.plazoTexto || '—')}</span>
          ${a.estado === 'terminada' ? `<span class="qc-due calculada">✅ Cumplida el ${escapeHTML(formatFecha(a.fechaCumplida || ''))}${a.cumplidaPor ? ' por ' + escapeHTML(nombreDe(a.cumplidaPor)) : ''}${v?.hasta && a.fechaCumplida && a.fechaCumplida > v.hasta ? ' · ⚠️ fuera de plazo' : ''}</span>` : a.estado === 'no_aplica' ? '' : (v?.hasta && v.hasta < hoyISO() ? `<span class="qc-due">⚠️ Atrasada · venció ${escapeHTML(formatFecha(v.hasta))}</span>` : vence)}
        </p>
        ${a.nota ? `<p class="qc-hint">📝 ${escapeHTML(a.nota)}</p>` : ''}
      </li>
    `;
  }

  function bindPlan() {
    // Eliminar el proyecto entero (solo administrador). No se borra nada de verdad: queda
    // anulado con su motivo, desaparece de las listas en todos los aparatos y el historial se conserva.
    container.querySelector('#qc-delete-project')?.addEventListener('click', async () => {
      if (!isOwner(email)) {
        toast('Solo el dueño de la cuenta puede eliminar un proyecto.');
        return;
      }
      const resumen = `${data.etapas.filter((e) => !e.anulado).length} etapas, ${data.actividades.filter((a) => !a.anulado).length} actividades, ${data.observaciones.filter((o) => !o.anulado).length} observaciones y ${data.certificaciones.filter((c) => !c.anulado).length} certificaciones`;
      const r = await promptDialog({
        title: 'Eliminar proyecto',
        fields: [
          { name: 'motivo', label: `Vas a eliminar "${data.proyecto.nombre}" (${resumen}). Desaparece de la lista en todos los aparatos. Motivo:`, placeholder: 'Ej: proyecto de prueba', maxlength: 200 },
          { name: 'confirmacion', label: 'Para confirmar, escribe ELIMINAR', maxlength: 20 },
        ],
        confirmLabel: 'Eliminar',
      });
      if (!r) return;
      if ((r.confirmacion || '').trim().toUpperCase() !== 'ELIMINAR') {
        toast('No se eliminó: faltó escribir ELIMINAR.');
        return;
      }
      // Eliminar es certificar: pide el PIN y deja la firma en el mismo evento que la anulación.
      const obraId = data.proyecto.obraId;
      const firmada = await certificar(firmaCtx, {
        tipo: 'proyecto',
        registro: data.proyecto,
        refTabla: 'proyectos',
        refCodigo: String(data.proyecto.nombre || '').slice(0, 50),
        accion: 'eliminada',
        nota: 'Proyecto eliminado y certificado',
        resumen: `Eliminar el proyecto "${data.proyecto.nombre}" (${resumen}).`,
        cambios: [{ op: 'void', table: 'proyectos', id: projectId, reason: (r.motivo || '').trim() || 'Eliminado por un administrador' }],
      });
      if (!firmada) return;
      toast('Proyecto eliminado.');
      navigate(obraId ? `/control/obra/${obraId}/calidad` : '/calidad');
    });

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
        const permiso = puedeActuar(a);
        if (!permiso.ok) {
          toast(permiso.msg);
          return;
        }
        const admin = isAdmin(email);
        const actual = personaDe(a);
        const fields = [
          { name: 'estado', label: 'Estado', type: 'select', value: a.estado, options: ESTADOS_ACTIVIDAD },
          { name: 'nota', label: 'Nota del control (qué se revisó, resultado)', value: a.nota || '' },
        ];
        if (admin) {
          fields.push(
            { name: 'responsableId', label: 'Responsable (persona)', type: 'select', value: actual?.id || (a.responsableTexto ? '__texto' : ''), options: opcionesResponsable(a) },
            { name: 'fechaManual', label: 'Fecha límite puesta a mano (déjala vacía para usar el cálculo)', type: 'date', value: a.fechaManual || '' },
            { name: 'plazoTexto', label: 'Plazo (texto)', value: a.plazoTexto || '' }
          );
        }
        const r = await promptDialog({ title: `Actividad ${a.codigo}`, fields });
        if (!r) return;
        const patch = {
          estado: r.estado,
          nota: r.nota || '',
          // Quien la marca completada queda registrado con su correo de Google.
          cumplidaPor: r.estado === 'terminada' ? (a.cumplidaPor || miCorreo || null) : null,
          fechaCumplida: r.estado === 'terminada' ? (a.fechaCumplida || hoyISO()) : null,
        };
        if (admin) {
          const persona = r.responsableId && r.responsableId !== '__texto' ? personas().find((x) => x.id === r.responsableId) : null;
          if (r.responsableId !== '__texto') {
            patch.responsableId = persona?.id || null;
            patch.responsableTexto = persona ? (persona.cargo || persona.nombre || '') : '';
          }
          patch.fechaManual = r.fechaManual || null;
          patch.plazoTexto = r.plazoTexto;
          patch.plazoParseado = parsePlazo(r.plazoTexto);
        }
        if (a.estado === 'terminada' && r.estado !== 'terminada') {
          toast('Esta actividad está certificada. Para cambiarla, anula la certificación en la pestaña Certificaciones.');
          return;
        }
        if (r.estado === 'terminada' && a.estado !== 'terminada') {
          // Terminar una actividad es certificarla: pide PIN y deja la firma en el mismo evento.
          const firmada = await certificar(firmaCtx, {
            tipo: 'actividad',
            registro: a,
            refTabla: 'actividades',
            refCodigo: a.codigo,
            accion: 'terminada',
            nota: `Actividad ${a.codigo} terminada y certificada`,
            resumen: a.descripcion.slice(0, 160),
            cambios: [{ op: 'set', table: 'actividades', id: a.id, patch }],
          });
          if (firmada) paint();
          return;
        }
        await save('actividades', a.id, patch, `Actividad ${a.codigo} editada`);
        paint();
      })
    );
  }

  // ---------- Tablero ----------

  function renderTablero() {
    const hoy = hoyISO();
    const etapas = data.etapas.filter((e) => !e.anulado);
    const entregas = data.entregas.filter((x) => !x.anulado);
    const etapaDe = (x) => etapas.find((e) => e.id === x.etapaId);
    const vencidas = entregas.filter((x) => entregaVencida(x, etapaDe(x), holidays(), hoy));
    const enRevision = entregas.filter((x) => [ESTADO_ENTREGA.recibida, ESTADO_ENTREGA.enRevision, ESTADO_ENTREGA.reentrega].includes(x.estado));
    const proximas = enRevision
      .map((x) => ({ x, vence: venceEntrega(x, etapaDe(x), holidays()) }))
      .filter((r) => r.vence)
      .sort((a, b) => a.vence.localeCompare(b.vence));

    const actividades = data.actividades.filter((a) => !a.anulado && a.estado !== 'terminada' && a.estado !== 'no_aplica');
    const limite = addCalendarDays(hoy, 14);
    const porVencer = actividades
      .map((a) => {
        const etapa = etapas.find((e) => e.id === a.etapaId);
        const v = etapa ? ventanaActividad(a, etapaEf(etapa), data.proyecto, holidays()) : null;
        return { a, hasta: v?.hasta || null };
      })
      .filter((r) => r.hasta && r.hasta <= limite)
      .sort((a, b) => a.hasta.localeCompare(b.hasta));

    // Etapas cuya entrega estaba prevista y todavía no llega completa.
    const sinEntrega = etapas
      .filter((e) => e.plazoRevisionDias != null && e.fechaRecepcion && e.fechaRecepcion < hoy)
      .filter((e) => !entregas.some((x) => x.etapaId === e.id && x.completa !== false && x.estado !== ESTADO_ENTREGA.devuelta))
      .map((e) => ({ e, dias: businessDaysBetween(e.fechaRecepcion, hoy, holidays()), devuelta: entregas.some((x) => x.etapaId === e.id) }));
    const alertasEntrega = sinEntrega.length
      ? `<section class="qc-card"><h3>⚠️ Entregas atrasadas</h3><ul class="qc-people">${sinEntrega.map(({ e, dias, devuelta }) => `<li class="qc-person overdue"><div><strong>${escapeHTML(e.codigo)} · ${escapeHTML(e.nombre)}</strong><p class="qc-person-meta">Estaba prevista para el ${escapeHTML(formatFecha(e.fechaRecepcion))} y ${devuelta ? 'solo llegó una entrega incompleta' : 'todavía no llega'}: ${dias} día(s) hábil(es) de atraso.</p></div></li>`).join('')}</ul></section>`
      : '';

    const yo = yoSoy();
    const mias = yo
      ? actividades.filter((a) => personaDe(a)?.id === yo.id).sort((a, b) => String(a.codigo).localeCompare(String(b.codigo), 'es', { numeric: true }))
      : [];
    const misActividades = yo
      ? `<section class="qc-card"><h3>Mis actividades pendientes (${mias.length})</h3><ul class="qc-people">${
          mias.slice(0, 8).map((a) => `<li class="qc-person"><div><strong>${escapeHTML(a.codigo)}</strong> ${escapeHTML(a.descripcion.slice(0, 90))}${a.descripcion.length > 90 ? '…' : ''}</div></li>`).join('') ||
          '<li class="qc-hint">No tienes actividades pendientes. 🎉</li>'
        }</ul>${mias.length > 8 ? `<p class="qc-hint">y ${mias.length - 8} más en Plan de calidad.</p>` : ''}</section>`
      : '';

    const abiertas = data.observaciones.filter((o) => !o.anulado && o.estado !== 'Cerrada');
    const porCategoria = (data.catalogos.categorias || []).map((c) => ({ c, n: abiertas.filter((o) => o.categoria === c.codigo).length }));

    const tile = (valor, etiqueta, clase = '') => `<div class="qc-kpi ${clase}"><span class="qc-kpi-value">${valor}</span><span class="qc-kpi-label">${etiqueta}</span></div>`;
    return `
      <section class="qc-kpis">
        ${tile(entregas.length, 'Entregas registradas')}
        ${tile(enRevision.length, 'En revisión')}
        ${tile(vencidas.length, 'Vencidas', vencidas.length ? 'bad' : '')}
        ${tile(actividades.length, 'Actividades pendientes')}
      </section>
      ${alertasEntrega}
      ${misActividades}
      <section class="qc-card">
        <h3>Observaciones abiertas</h3>
        <p class="qc-chips">${porCategoria.map(({ c, n }) => `<span class="qc-chip">${escapeHTML(c.codigo)} · ${escapeHTML(c.nombre)}: <strong>${n}</strong></span>`).join('') || '<span class="qc-hint">Sin categorías.</span>'}</p>
        ${data.observaciones.length ? '' : '<p class="qc-hint">Todavía no hay observaciones. Se registran en la pestaña Observaciones.</p>'}
      </section>
      <section class="qc-card">
        <h3>Plazos de revisión que corren</h3>
        <ul class="qc-people">
          ${proximas.map(({ x, vence }) => {
            const et = etapaDe(x);
            const vencida = vence < hoy;
            return `<li class="qc-person${vencida ? ' overdue' : ''}"><div><strong>${escapeHTML(et?.codigo || '')} · ${escapeHTML(et?.nombre || '')} (${escapeHTML(x.version || '')})</strong><p class="qc-person-meta">${vencida ? '⚠️ Vencida el' : 'Vence el'} ${escapeHTML(formatFecha(vence))}</p></div></li>`;
          }).join('') || '<li class="qc-hint">No hay revisiones en curso.</li>'}
        </ul>
      </section>
      <section class="qc-card">
        <h3>Actividades con fecha en los próximos 14 días</h3>
        <ul class="qc-people">
          ${porVencer.map(({ a, hasta }) => `<li class="qc-person${hasta < hoy ? ' overdue' : ''}"><div><strong>${escapeHTML(a.codigo)}</strong> ${escapeHTML(a.descripcion.slice(0, 90))}${a.descripcion.length > 90 ? '…' : ''}<p class="qc-person-meta">${hasta < hoy ? '⚠️ Venció el' : 'Vence el'} ${escapeHTML(formatFecha(hasta))} · ${escapeHTML(a.responsableTexto || '')}</p></div></li>`).join('') || '<li class="qc-hint">Nada por vencer. Si no ves actividades, falta poner fechas de recepción o de inicio.</li>'}
        </ul>
      </section>
    `;
  }

  function bindTablero() {}

  // ---------- Entregas ----------

  function renderEntregas() {
    const etapas = data.etapas.filter((e) => !e.anulado && e.plazoRevisionDias != null);
    const hoy = hoyISO();
    if (!etapas.length) return '<div class="empty-state"><p>Este proyecto no tiene etapas con entregas.</p></div>';
    return etapas.map((e) => {
      const entregas = ordenarEntregas(entregasDe(e.id));
      return `
        <section class="qc-card">
          <div class="qc-card-header">
            <h3><span class="qc-code">${escapeHTML(e.codigo)}</span> ${escapeHTML(e.nombre)}</h3>
            <button type="button" class="btn btn-primary" data-new-entrega="${e.id}">➕ Registrar entrega</button>
          </div>
          <p class="qc-hint">Plazo de revisión: ${e.plazoRevisionDias} días hábiles desde la recepción de la entrega completa.</p>
          <ul class="qc-people">
            ${entregas.map((x) => {
              const vence = venceEntrega(x, e, holidays());
              const vencida = entregaVencida(x, e, holidays(), hoy);
              const bloq = observacionesBloqueantes(data, x.id).length;
              const completa = x.completa !== false && x.estado !== ESTADO_ENTREGA.devuelta;
              const idx = entregas.indexOf(x);
              // Reingreso tras una devolución por incompleta: cuántos días hábiles tardó.
              const devueltaPrevia = completa ? [...entregas.slice(0, idx)].reverse().find((y) => y.estado === ESTADO_ENTREGA.devuelta || y.completa === false) : null;
              const desfaseReingreso = devueltaPrevia && x.fechaRecepcion ? businessDaysBetween(devueltaPrevia.fechaDevolucion || devueltaPrevia.fechaRecepcion, x.fechaRecepcion, holidays()) : null;
              // Atraso de la primera entrega completa frente a la fecha prevista de la etapa.
              const primeraCompleta = entregas.find((y) => y.completa !== false && y.estado !== ESTADO_ENTREGA.devuelta);
              const atraso = completa && x === primeraCompleta && e.fechaRecepcion && x.fechaRecepcion && x.fechaRecepcion > e.fechaRecepcion ? businessDaysBetween(e.fechaRecepcion, x.fechaRecepcion, holidays()) : 0;
              return `
                <li class="qc-person${vencida ? ' overdue' : ''}${x.estado === ESTADO_ENTREGA.devuelta ? ' inactive' : ''}">
                  <div>
                    <strong>${escapeHTML(x.version || 'Entrega')}</strong>
                    <span class="qc-role-tag">${escapeHTML(x.estado || '')}</span>
                    <p class="qc-person-meta">Recibida ${escapeHTML(formatFecha(x.fechaRecepcion))} · ${x.completa === false ? '❌ incompleta' : '✅ completa'}${x.notaRemisoria ? ' · con nota remisoria' : ''}</p>
                    ${vence ? `<p class="qc-person-meta">${vencida ? '⚠️ Revisión vencida el' : 'Revisión vence el'} ${escapeHTML(formatFecha(vence))}</p>` : ''}
                    ${x.fechaInforme ? `<p class="qc-person-meta">Informe de revisión: ${escapeHTML(formatFecha(x.fechaInforme))}</p>` : ''}
                    ${x.fechaDevolucion ? `<p class="qc-person-meta">Devuelta el ${escapeHTML(formatFecha(x.fechaDevolucion))}</p>` : ''}
                    ${desfaseReingreso != null ? `<p class="qc-person-meta qc-warn">↪️ Reingreso completo ${desfaseReingreso} día(s) hábil(es) después de la devolución de ${escapeHTML(devueltaPrevia.version || 'la entrega anterior')}</p>` : ''}
                    ${atraso > 0 ? `<p class="qc-person-meta qc-warn">⏰ Atraso de ${atraso} día(s) hábil(es) respecto de la fecha prevista (${escapeHTML(formatFecha(e.fechaRecepcion))})</p>` : ''}
                    ${bloq ? `<p class="qc-person-meta">🔒 ${bloq} observación(es) impiden aprobarla</p>` : ''}
                    ${x.aprobacion1Por ? `<p class="qc-person-meta">✍️ ${x.estado === ESTADO_ENTREGA.aprobada ? 'Aprobada' : 'Recomendada'} por ${escapeHTML(nombreDe(x.aprobacion1Por))}${x.aprobacion2Por ? ' y ' + escapeHTML(nombreDe(x.aprobacion2Por)) + ' (Gobernanza)' : ''}</p>` : ''}
                    ${puedeSegundaFirma(x) ? '<p class="qc-person-meta qc-warn">⏳ Falta la segunda firma de Gobernanza</p>' : ''}
                  </div>
                  ${puedeSegundaFirma(x) && (isAdmin(email) || yoSoy()?.rol === 'gobernanza') && x.aprobacion1Por !== miCorreo ? `<button type="button" class="btn btn-primary" data-firma2="${x.id}">✍️ Firmar</button>` : ''}
                  ${completa ? `<button type="button" class="btn btn-secondary" data-informe="${x.id}" title="Informe de revisión en PDF">📄 Informe</button>` : ''}
                  <button type="button" class="icon-btn" data-edit-entrega="${x.id}" title="Editar">✏️</button>
                </li>`;
            }).join('') || '<li class="qc-hint">Todavía no llega ninguna entrega de esta etapa.</li>'}
          </ul>
        </section>`;
    }).join('');
  }

  const SI_NO = [{ value: 'si', label: 'Sí' }, { value: 'no', label: 'No' }];
  const puedeSegundaFirma = (x) => x.requiereSegundaFirma && x.estado === ESTADO_ENTREGA.recomendada && x.aprobacion1Por && !x.aprobacion2Por;

  async function registrarEntrega(etapaId) {
    const etapa = data.etapas.find((e) => e.id === etapaId);
    const previas = entregasDe(etapaId);
    const r = await promptDialog({
      title: `Registrar entrega — ${etapa.nombre}`,
      fields: [
        { name: 'version', label: 'Versión', value: `v${previas.length + 1}`, maxlength: 20 },
        { name: 'fechaRecepcion', label: 'Fecha de recepción', type: 'date', value: hoyISO() },
        { name: 'completa', label: '¿La entrega viene completa?', type: 'select', value: 'si', options: SI_NO },
        { name: 'notaRemisoria', label: '¿Viene con nota remisoria firmada?', type: 'select', value: 'si', options: SI_NO },
      ],
      confirmLabel: 'Registrar',
    });
    if (!r || !r.fechaRecepcion) return;
    const completa = r.completa !== 'no';
    const hayCompletaPrevia = previas.some((x) => x.completa !== false && x.estado !== ESTADO_ENTREGA.devuelta);
    const patch = {
      etapaId,
      version: r.version || `v${previas.length + 1}`,
      fechaRecepcion: r.fechaRecepcion,
      completa,
      notaRemisoria: r.notaRemisoria !== 'no',
      estado: !completa ? ESTADO_ENTREGA.devuelta : hayCompletaPrevia ? ESTADO_ENTREGA.reentrega : ESTADO_ENTREGA.enRevision,
      fechaDevolucion: completa ? null : r.fechaRecepcion,
      fechaInforme: null,
    };
    await save('entregas', qcNewId(), patch, `Entrega ${patch.version} registrada (${etapa.codigo})`);
    toast(completa ? 'Entrega registrada. Corre el plazo de revisión.' : 'Entrega devuelta por incompleta: el plazo no corre.');
    paint();
  }

  async function editarEntrega(entregaId) {
    const x = data.entregas.find((e) => e.id === entregaId);
    const etapa = data.etapas.find((e) => e.id === x.etapaId);
    const estados = data.catalogos.estadosEntrega?.length ? data.catalogos.estadosEntrega : Object.values(ESTADO_ENTREGA);
    const r = await promptDialog({
      title: `Entrega ${x.version} — ${etapa.nombre}`,
      fields: [
        { name: 'estado', label: 'Estado', type: 'select', value: x.estado, options: estados.map((e) => ({ value: e, label: e })) },
        { name: 'fechaRecepcion', label: 'Fecha de recepción', type: 'date', value: x.fechaRecepcion || '' },
        { name: 'fechaInforme', label: 'Fecha del informe de revisión', type: 'date', value: x.fechaInforme || '' },
        { name: 'completa', label: '¿Viene completa?', type: 'select', value: x.completa === false ? 'no' : 'si', options: SI_NO },
        { name: 'requiereSegundaFirma', label: '¿La aprobación necesita la segunda firma de Gobernanza?', type: 'select', value: x.requiereSegundaFirma ? 'si' : 'no', options: SI_NO },
        { name: 'version', label: 'Versión', value: x.version || '', maxlength: 20 },
      ],
    });
    if (!r) return;
    const bloqueantes = observacionesBloqueantes(data, x.id);
    if ([ESTADO_ENTREGA.recomendada, ESTADO_ENTREGA.aprobada].includes(r.estado) && bloqueantes.length) {
      toast(`No se puede: hay ${bloqueantes.length} observación(es) que impiden recomendar o aprobar esta entrega.`);
      return;
    }
    const completa = r.completa !== 'no';
    const estado = !completa ? ESTADO_ENTREGA.devuelta : r.estado === ESTADO_ENTREGA.devuelta ? ESTADO_ENTREGA.enRevision : r.estado;
    const patch = {
      estado,
      fechaRecepcion: r.fechaRecepcion || null,
      fechaInforme: r.fechaInforme || null,
      completa,
      version: r.version,
      requiereSegundaFirma: r.requiereSegundaFirma === 'si',
      fechaDevolucion: !completa ? (x.fechaDevolucion || hoyISO()) : null,
    };
    // Una entrega aprobada está certificada: solo se cambia anulando la certificación.
    if (x.estado === ESTADO_ENTREGA.aprobada && estado !== ESTADO_ENTREGA.aprobada) {
      toast('Esta entrega está aprobada y certificada. Para cambiarla, anula la certificación en la pestaña Certificaciones.');
      return;
    }
    if (estado === ESTADO_ENTREGA.aprobada && x.estado !== ESTADO_ENTREGA.aprobada) {
      // Aprobar es certificar: solo el responsable del proyecto (o un administrador) y con su PIN.
      if (!(isAdmin(email) || yoSoy()?.rol === 'responsable')) {
        toast('Solo el responsable del proyecto puede aprobar una entrega.');
        return;
      }
      const dos = patch.requiereSegundaFirma;
      const firmada = await certificar(firmaCtx, {
        tipo: 'entrega',
        registro: x,
        refTabla: 'entregas',
        refCodigo: `${etapa.codigo} · ${x.version}`,
        accion: dos ? 'recomendada' : 'aprobada',
        nota: dos ? `Entrega ${x.version} recomendada para aprobación (falta segunda firma)` : `Entrega ${x.version} aprobada y certificada`,
        resumen: `${etapa.nombre} · ${x.version}`,
        cambios: [{ op: 'set', table: 'entregas', id: x.id, patch: dos ? { ...patch, estado: ESTADO_ENTREGA.recomendada, aprobacion1Por: miCorreo, aprobacion2Por: null } : { ...patch, aprobacion1Por: miCorreo, fechaAprobacion: hoyISO() } }],
      });
      if (firmada) {
        if (dos) toast('Falta la segunda firma de Gobernanza para aprobarla.');
        paint();
      }
      return;
    }
    await save('entregas', x.id, patch, `Entrega ${x.version} editada`);
    paint();
  }

  /** Segunda firma (gobernanza) que completa la aprobación de una entrega. */
  async function segundaFirma(entregaId) {
    const x = data.entregas.find((e) => e.id === entregaId);
    const etapa = data.etapas.find((e) => e.id === x.etapaId);
    if (observacionesBloqueantes(data, x.id).length) {
      toast('No se puede aprobar: hay observaciones que la impiden.');
      return;
    }
    const firmada = await certificar(firmaCtx, {
      tipo: 'entrega',
      registro: x,
      refTabla: 'entregas',
      refCodigo: `${etapa.codigo} · ${x.version}`,
      accion: 'aprobada',
      nivel: 2,
      nota: `Entrega ${x.version} aprobada con segunda firma`,
      resumen: `${etapa.nombre} · ${x.version} (segunda firma)`,
      cambios: [{ op: 'set', table: 'entregas', id: x.id, patch: { estado: ESTADO_ENTREGA.aprobada, aprobacion2Por: miCorreo, fechaAprobacion: hoyISO() } }],
    });
    if (firmada) paint();
  }

  function bindEntregas() {
    container.querySelectorAll('[data-new-entrega]').forEach((b) => b.addEventListener('click', () => registrarEntrega(b.dataset.newEntrega)));
    container.querySelectorAll('[data-edit-entrega]').forEach((b) => b.addEventListener('click', () => editarEntrega(b.dataset.editEntrega)));
    container.querySelectorAll('[data-firma2]').forEach((b) => b.addEventListener('click', () => segundaFirma(b.dataset.firma2)));
    container.querySelectorAll('[data-informe]').forEach((b) => b.addEventListener('click', () => generarInforme(b.dataset.informe)));
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
                ${x.correo ? `<p class="qc-person-meta">${tienePin(data.pines.find((p) => p.id === idPin(x.correo) && !p.anulado)) ? '🔐 Ya creó su PIN y su firma' : 'Sin PIN todavía (lo crea la primera vez que firme)'}</p>` : ''}
              </div>
              ${isAdmin(email) && x.correo && tienePin(data.pines.find((p) => p.id === idPin(x.correo) && !p.anulado)) ? `<button type="button" class="icon-btn" data-reset-pin="${escapeHTML(x.correo)}" title="Restablecer PIN y firma">🔑</button>` : ''}
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
    container.querySelectorAll('[data-reset-pin]').forEach((b) =>
      b.addEventListener('click', async () => {
        const correo = b.dataset.resetPin;
        if (!(await confirmDialog(`¿Restablecer el PIN y la firma de ${correo}? Tendrá que crear unos nuevos la próxima vez que firme. Las firmas ya hechas no cambian.`, 'Restablecer'))) return;
        await reiniciarPin(firmaCtx, correo);
        paint();
      })
    );
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
      <section class="qc-card">
        <h3>Estados</h3>
        <p class="qc-hint">Los usa el sistema para sus reglas (plazos, bloqueo de aprobación), por eso no se editan.</p>
        <p class="qc-chips">${Object.values(ESTADO_ENTREGA).map((t) => `<span class="qc-chip">${escapeHTML(t)}</span>`).join('')}</p>
        <p class="qc-chips">${(data.catalogos.estadosObservacion || []).map((t) => `<span class="qc-chip">${escapeHTML(t)}</span>`).join('')}</p>
      </section>
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

  // Sincroniza con Drive en segundo plano: baja lo que hizo el resto del
  // equipo y sube lo propio. Nunca pide sesión de Google por su cuenta.
  const hashAlAbrir = location.hash;
  const sigueAbierto = () => location.hash === hashAlAbrir && !!container.querySelector('#qc-content');
  const quitar = onQcChange(async (info) => {
    if (!sigueAbierto()) {
      quitar();
      return;
    }
    if (info.projectId && info.projectId !== projectId) return;
    await reload();
    paint();
    toast(`📥 ${info.pulled} cambio(s) del equipo.`);
  });
  qcSyncProject(projectId);
}
