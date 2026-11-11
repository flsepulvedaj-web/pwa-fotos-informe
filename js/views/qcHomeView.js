import { getSignedInEmail } from '../googleDrive.js';
import { modulesForEmail, getCachedPermissions } from '../permissions.js';
import { qcListProjects, qcLoadProject, qcCreateProject, qcCommit } from '../qcStore.js';
import { TEMPLATES, catalogOps, templateStageOps } from '../qcTemplates.js';
import { parseQualityPlanDocx, planToProjectOps } from '../qcPlanParser.js';
import { getObra } from '../db.js';
import { navigate } from '../router.js';
import { promptDialog, toast, escapeHTML } from '../utils.js';

/**
 * Pantalla de inicio del módulo Control de calidad de proyectos: lista de
 * proyectos revisados y botón para crear uno nuevo (cargando un plan en Word,
 * desde una plantilla genérica o en blanco).
 */
export async function renderQcHomeView(container, obraId) {
  const email = await getSignedInEmail();
  const allowed = modulesForEmail(email, getCachedPermissions());
  // Con `obraId` es la sección "Control de calidad" de una obra de Control;
  // sin él es la lista general (para quien solo tiene este módulo).
  const obra = obraId ? await getObra(obraId) : null;
  const backRoute = obraId ? `/control/obra/${obraId}` : allowed.includes('control') ? '/control' : '/proyectos';
  const title = obra ? `Control de calidad · ${obra.name}` : 'Control de calidad de proyectos';

  if (obraId && !obra) {
    navigate('/control');
    return;
  }

  if (!allowed.includes('calidad')) {
    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Control de calidad</span>
      </header>
      <main class="view-content"><div class="empty-state"><p>No tienes acceso a este módulo.</p><p>Pídele acceso a Pancho.</p></div></main>
    `;
    container.querySelector('#btn-back').addEventListener('click', () => navigate(backRoute));
    return;
  }

  const projects = await qcListProjects(obraId);
  // Proyectos creados con la primera versión del módulo, que todavía no
  // pertenecen a ninguna obra: se ofrece asociarlos a esta.
  const sinObra = obraId ? (await qcListProjects()).filter((p) => !p.obraId) : [];
  const summaries = await Promise.all(
    projects.map(async (p) => {
      const data = await qcLoadProject(p.id);
      return { project: p, etapas: data.etapas.filter((e) => !e.anulado).length, actividades: data.actividades.filter((a) => !a.anulado).length };
    })
  );

  container.innerHTML = `
    <header class="app-header">
      <button class="icon-btn" id="btn-back" title="Volver">←</button>
      <span class="header-title">${escapeHTML(title)}</span>
    </header>
    <main class="view-content">
      ${sinObra.length ? `
        <section class="qc-card">
          <p class="modal-message">Hay ${sinObra.length} proyecto${sinObra.length === 1 ? '' : 's'} de calidad sin obra: ${escapeHTML(sinObra.map((p) => p.nombre).join(', '))}.</p>
          <button type="button" class="btn btn-secondary" id="btn-adopt">Asociar a "${escapeHTML(obra.name)}"</button>
        </section>
      ` : ''}
      ${summaries.length ? `
        <section class="qc-project-list">
          ${summaries.map(({ project, etapas, actividades }) => `
            <button type="button" class="qc-project-card" data-id="${project.id}">
              <span class="qc-project-name">${escapeHTML(project.nombre)}</span>
              <span class="qc-project-meta">${escapeHTML([project.codigo, project.mandante].filter(Boolean).join(' · '))}</span>
              <span class="qc-project-meta">${etapas} etapa${etapas === 1 ? '' : 's'} · ${actividades} actividad${actividades === 1 ? '' : 'es'}${project.estado === 'cerrado' ? ' · cerrado' : ''}</span>
            </button>
          `).join('')}
        </section>
      ` : `
        <div class="empty-state">
          <p>Todavía no hay proyectos.</p>
          <p>Crea uno cargando un plan de control de calidad en Word, o partiendo de una plantilla.</p>
        </div>
      `}
    </main>
    <div class="fab-row">
      <button class="fab fab-primary" id="btn-new-project" title="Nuevo proyecto">➕</button>
    </div>
  `;

  container.querySelector('#btn-back').addEventListener('click', () => navigate(backRoute));
  container.querySelectorAll('.qc-project-card').forEach((card) => {
    card.addEventListener('click', () => navigate(`/calidad/proyecto/${card.dataset.id}`));
  });
  container.querySelector('#btn-new-project').addEventListener('click', () => startNewProject(obraId));
  container.querySelector('#btn-adopt')?.addEventListener('click', async () => {
    for (const p of sinObra) await qcCommit(p.id, [{ op: 'set', table: 'proyectos', id: p.id, patch: { obraId } }], `Asociado a la obra "${obra.name}"`);
    toast('Listo.');
    renderQcHomeView(container, obraId);
  });
}

function chooseTemplate() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h2>Nuevo proyecto</h2>
        <div class="qc-template-list">
          ${TEMPLATES.map((t) => `
            <button type="button" class="qc-template-btn" data-template="${t.id}">
              <strong>${escapeHTML(t.label)}</strong>
              <span>${escapeHTML(t.desc)}</span>
            </button>
          `).join('')}
        </div>
        <div class="modal-actions"><button type="button" class="btn btn-secondary" data-action="cancel">Cancelar</button></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-template]');
      if (btn || e.target === overlay || e.target.closest('[data-action="cancel"]')) {
        overlay.remove();
        resolve(btn ? btn.dataset.template : null);
      }
    });
  });
}

function pickDocxFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    input.addEventListener('change', () => resolve(input.files?.[0] || null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

function planSummarySheet(plan) {
  const r = plan.resumen;
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal ai-avance-result" role="dialog" aria-modal="true">
        <h2>Esto encontré en el plan</h2>
        <p class="modal-message"><strong>${escapeHTML(plan.proyecto.nombre)}</strong></p>
        <ul class="ai-avance-substitutions">
          <li>${r.etapas} etapas con <strong>${r.actividades} actividades</strong> de control</li>
          <li>${r.conFechaCalculable} actividades con fecha calculable apenas pongas la fecha de recepción de cada entrega</li>
          <li>${r.participantes} roles, ${r.categorias} categorías de observación y ${r.especialidades} especialidades</li>
        </ul>
        ${plan.pendientes.length ? `
          <p class="modal-message">Quedan por completar después en la app:</p>
          <ul class="ai-avance-substitutions">${plan.pendientes.map((p) => `<li>${escapeHTML(p)}</li>`).join('')}</ul>
        ` : ''}
        <p class="modal-message">Las fechas quedan vacías: las pones tú cuando se sepan.</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-action="cancel">Cancelar</button>
          <button type="button" class="btn btn-primary" data-action="confirm">Crear proyecto</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (btn || e.target === overlay) {
        overlay.remove();
        resolve(btn?.dataset.action === 'confirm');
      }
    });
  });
}

async function startNewProject(obraId) {
  const templateId = await chooseTemplate();
  if (!templateId) return;

  if (templateId === 'plan') {
    const file = await pickDocxFile();
    if (!file) return;
    toast('Leyendo el plan…');
    let plan;
    try {
      plan = await parseQualityPlanDocx(await file.arrayBuffer());
    } catch (err) {
      console.error(err);
      toast(err.message || 'No se pudo leer el archivo.');
      return;
    }
    if (!plan.ok) {
      toast(plan.error);
      return;
    }
    if (!(await planSummarySheet(plan))) return;
    const { projectData, ops } = planToProjectOps(plan);
    const id = await qcCreateProject({ ...projectData, obraId: obraId || null, plantilla: 'plan', archivoPlan: file.name }, ops, `Proyecto creado desde el plan "${file.name}"`);
    toast('Proyecto creado.');
    navigate(`/calidad/proyecto/${id}`);
    return;
  }

  const result = await promptDialog({
    title: 'Datos del proyecto',
    fields: [
      { name: 'nombre', label: 'Nombre del proyecto', placeholder: 'Ej: Oficinas BID Chile' },
      { name: 'mandante', label: 'Mandante', placeholder: 'Ej: Banco Interamericano de Desarrollo' },
    ],
    confirmLabel: 'Crear',
  });
  if (!result?.nombre) return;
  const id = await qcCreateProject(
    { nombre: result.nombre, mandante: result.mandante, tipo: 'Revisión de proyecto', plantilla: templateId, obraId: obraId || null },
    [...catalogOps(), ...templateStageOps(templateId)],
    `Proyecto creado desde la plantilla "${templateId}"`
  );
  toast('Proyecto creado.');
  navigate(`/calidad/proyecto/${id}`);
}
