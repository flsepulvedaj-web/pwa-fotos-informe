import {
  getObra,
  getChecklistTypesByObra,
  getChecklistEntriesByObra,
  getChecklistEntry,
  updateChecklistEntry,
  getSSMAEntriesByObra,
  getScheduleSnapshotsByObra,
} from '../db.js';
import {
  computeAvanceKPI,
  computePersonalKPI,
  computeChecklistKPI,
  computeAtrasadas,
  renderLineChartSVG,
  renderBarChartSVG,
} from '../controlDashboard.js';
import { navigate } from '../router.js';
import { escapeHTML, toast } from '../utils.js';

function formatDateEs(iso) {
  if (!iso) return '—';
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

const STATUS_LABEL = {
  NO_ENTREGADO: 'No entregado',
  INCOMPLETO: 'Incompleto',
  EN_REVISION: 'En revisión',
  NO_LO_TIENEN: 'No lo tienen',
};

/**
 * Pantalla principal de Control para una obra: dashboard de KPI arriba
 * (avance, personal, cumplimiento del checklist, incumplimientos abiertos y
 * tareas atrasadas) + accesos a cada sección abajo. Las secciones que
 * todavía no están construidas se muestran marcadas "Próximamente".
 */
export async function renderControlObraView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  const [types, checklistEntries, ssmaEntries, snapshots] = await Promise.all([
    getChecklistTypesByObra(obraId),
    getChecklistEntriesByObra(obraId),
    getSSMAEntriesByObra(obraId),
    getScheduleSnapshotsByObra(obraId),
  ]);

  const avance = computeAvanceKPI(snapshots);
  const personal = computePersonalKPI(ssmaEntries);
  const checklist = computeChecklistKPI(checklistEntries, types);
  const atrasadas = computeAtrasadas(snapshots);

  const sections = [
    { id: 'personal', icon: '👷', title: 'Personal en obra', desc: 'Cuántos hay hoy (propio/subcontrato)', ready: true },
    { id: 'checklist', icon: '✅', title: 'Checklist diario', desc: 'SSMA, Faenas y Programación', ready: true },
    { id: 'avance', icon: '📅', title: 'Avance programado', desc: 'Importar programación desde Project', ready: true },
    { id: 'actas', icon: '📝', title: 'Actas de reunión', desc: 'Asistentes, temas, acuerdos', ready: false },
  ];

  function paint() {
    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">${escapeHTML(obra.name)}</span>
      </header>
      <main class="view-content">
        <section class="kpi-tiles">
          <div class="kpi-tile">
            <div class="kpi-value">${avance.latestPercent !== null ? avance.latestPercent + '%' : '—'}</div>
            <div class="kpi-label">Avance programado</div>
          </div>
          <div class="kpi-tile">
            <div class="kpi-value">${personal.todayTotal !== null ? personal.todayTotal : '—'}</div>
            <div class="kpi-label">Personal hoy</div>
          </div>
          <div class="kpi-tile">
            <div class="kpi-value">${checklist.cumplimientoPercent !== null ? checklist.cumplimientoPercent + '%' : '—'}</div>
            <div class="kpi-label">Cumplimiento checklist (30d)</div>
          </div>
        </section>

        ${avance.history.length >= 2 || personal.history.length >= 2 ? `
          <section class="dashboard-charts">
            ${avance.history.length >= 2 ? `
              <div class="dashboard-chart-card">
                <div class="dashboard-chart-title">Avance en el tiempo</div>
                ${renderLineChartSVG(avance.history)}
              </div>
            ` : ''}
            ${personal.history.length >= 2 ? `
              <div class="dashboard-chart-card">
                <div class="dashboard-chart-title">Personal en el tiempo</div>
                ${renderBarChartSVG(personal.history)}
              </div>
            ` : ''}
          </section>
        ` : ''}

        ${checklist.incumplimientos.length || atrasadas.length ? `
          <section class="incumplimientos-panel">
            <h3>⚠️ Pendientes (${checklist.incumplimientos.length + atrasadas.length})</h3>
            ${atrasadas.map((t) => `
              <div class="incumplimiento-row">
                <div class="incumplimiento-main">
                  <span class="incumplimiento-tag">Programación</span>
                  <span class="incumplimiento-label">${escapeHTML(t.name)}</span>
                  <span class="incumplimiento-meta">Atrasada — fin ${formatDateEs(t.plannedEnd)}, ${t.plannedPercent}%</span>
                </div>
              </div>
            `).join('')}
            ${checklist.incumplimientos.map((it) => `
              <div class="incumplimiento-row">
                <div class="incumplimiento-main">
                  <span class="incumplimiento-tag">${escapeHTML(it.typeTitle)}</span>
                  <span class="incumplimiento-label">${escapeHTML(it.label)}</span>
                  <span class="incumplimiento-meta">${formatDateEs(it.date)} — ${STATUS_LABEL[it.status] || it.status}</span>
                </div>
                <button type="button" class="btn btn-secondary incumplimiento-resolve-btn" data-entry-id="${it.entryId}" data-item-index="${it.itemIndex}">Marcar resuelto</button>
              </div>
            `).join('')}
          </section>
        ` : `
          <div class="incumplimientos-ok">✅ Sin pendientes abiertos</div>
        `}

        <section class="control-section-grid">
          ${sections.map((s) => `
            <button type="button" class="module-card control-section-card${s.ready ? '' : ' control-section-soon'}" data-section="${s.id}">
              <span class="module-icon">${s.icon}</span>
              <span class="module-title">${s.title}</span>
              <span class="module-desc">${s.ready ? s.desc : 'Próximamente'}</span>
            </button>
          `).join('')}
        </section>
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate('/control'));

    container.querySelectorAll('.control-section-card').forEach((card) => {
      card.addEventListener('click', () => {
        const section = card.dataset.section;
        if (section === 'personal') {
          navigate(`/control/obra/${obraId}/personal`);
        } else if (section === 'checklist') {
          navigate(`/control/obra/${obraId}/checklist`);
        } else if (section === 'avance') {
          navigate(`/control/obra/${obraId}/avance`);
        }
        // Las demás secciones todavía no tienen vista — no hacen nada al
        // tocarlas (quedan visibles para mostrar el mapa completo del módulo).
      });
    });

    container.querySelectorAll('.incumplimiento-resolve-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const entryId = btn.dataset.entryId;
        const itemIndex = Number(btn.dataset.itemIndex);
        const entry = await getChecklistEntry(entryId);
        if (!entry) return;
        entry.items[itemIndex].resolved = true;
        await updateChecklistEntry(entryId, { items: entry.items });
        toast('Marcado como resuelto.');
        renderControlObraView(container, obraId);
      });
    });
  }

  paint();
}
