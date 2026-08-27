import {
  getObra,
  getChecklistTypesByObra,
  getChecklistEntriesByObra,
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
import { isSignedIn, getSignedInEmail } from '../googleDrive.js';
import { syncChecklistFromDrive, syncSSMAFromDrive, syncAvanceFromDrive } from '../controlSync.js';
import { modulesForEmail, getCachedPermissions, isAdmin } from '../permissions.js';
import { resetPendientes } from '../controlReset.js';
import { navigate } from '../router.js';
import { escapeHTML, confirmDialog, toast } from '../utils.js';

function formatDateEs(iso) {
  if (!iso) return '—';
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * Pantalla principal de Control para una obra: dashboard de KPI arriba
 * (avance, personal, cumplimiento del checklist, incumplimientos abiertos y
 * tareas atrasadas) + accesos a cada sección abajo. Al abrir la obra, si
 * hay carpetas de Drive vinculadas, sincroniza en segundo plano lo que haya
 * cargado el resto del equipo (ej. el ITO en terreno) — así Pancho ve el
 * estado real sin tener que entrar a cada sección primero.
 */
export async function renderControlObraView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  // Costos es "dato rosa": vive adentro de Control (no es un módulo aparte
  // en el hub de Proyectos) pero sigue protegido con su propio permiso —
  // alguien con acceso a Control (ej. el ITO en terreno) no ve esta tarjeta
  // a menos que además tenga el permiso 'costos'. Por eso NI SIQUIERA se
  // agrega al arreglo si no corresponde (a diferencia de "Actas", que se
  // muestra griseada como "Próximamente" — acá directamente no existe para
  // quien no debe verla).
  const email = await getSignedInEmail();
  const allowedModules = modulesForEmail(email, getCachedPermissions());
  const sections = [
    { id: 'personal', icon: '👷', title: 'Personal en obra', desc: 'Directo, indirecto y subcontratos', ready: true },
    { id: 'checklist', icon: '✅', title: 'Checklist diario', desc: 'SSMA, Faenas y Programación', ready: true },
    { id: 'avance', icon: '📅', title: 'Avance programado', desc: 'Importar programación desde Project', ready: true },
    ...(allowedModules.includes('costos') ? [{ id: 'costos', icon: '💰', title: 'Costos', desc: 'Presupuesto, modificaciones, facturación y reembolsos', ready: true }] : []),
    ...(allowedModules.includes('rdi') ? [{ id: 'rdi', icon: '📨', title: 'RDI', desc: 'Requerimientos de información al mandante', ready: true }] : []),
    // Subcontratos y Organismos Públicos NO tienen permiso propio (a
    // diferencia de Costos/RDI) — son listas de directorio/seguimiento, no
    // información sensible, así que cualquiera con acceso a Control las ve.
    { id: 'subcontratos', icon: '📇', title: 'Subcontratos', desc: 'Directorio de subcontratos activos', ready: true },
    { id: 'organismos', icon: '🏛️', title: 'Organismos Públicos', desc: 'Estado de trámites (SEC, etc.)', ready: true },
    { id: 'informe-semanal', icon: '📑', title: 'Informe Semanal', desc: 'Acta, participantes, temas y compilado de KPI', ready: true },
  ];

  async function loadData() {
    const [types, checklistEntries, ssmaEntries, snapshots] = await Promise.all([
      getChecklistTypesByObra(obraId),
      getChecklistEntriesByObra(obraId),
      getSSMAEntriesByObra(obraId),
      getScheduleSnapshotsByObra(obraId),
    ]);
    return { types, checklistEntries, ssmaEntries, snapshots };
  }

  let data = await loadData();

  function paint() {
    const avance = computeAvanceKPI(data.snapshots);
    const personal = computePersonalKPI(data.ssmaEntries);
    const checklist = computeChecklistKPI(data.checklistEntries, data.types);
    const atrasadas = computeAtrasadas(data.snapshots);

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
            ${isAdmin(email) ? `
              <button type="button" class="btn btn-secondary incumplimientos-reset-btn" id="btn-reset-pendientes">🧹 Reiniciar pendientes de esta obra</button>
            ` : ''}
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
                  <span class="incumplimiento-meta">${formatDateEs(it.date)} — sin contestar</span>
                  ${it.observacion ? `<span class="incumplimiento-observacion">"${escapeHTML(it.observacion)}"</span>` : ''}
                </div>
                <button type="button" class="btn btn-secondary incumplimiento-resolve-btn" data-type-key="${it.typeKey}" data-date="${it.date}" data-item-index="${it.itemIndex}">Resolver</button>
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
        } else if (section === 'costos') {
          navigate(`/costos/obra/${obraId}`);
        } else if (section === 'rdi') {
          navigate(`/rdi/obra/${obraId}`);
        } else if (section === 'subcontratos') {
          navigate(`/subcontratos/obra/${obraId}`);
        } else if (section === 'organismos') {
          navigate(`/organismos/obra/${obraId}`);
        } else if (section === 'informe-semanal') {
          navigate(`/informe-semanal/obra/${obraId}`);
        }
        // Las demás secciones todavía no tienen vista — no hacen nada al
        // tocarlas (quedan visibles para mostrar el mapa completo del módulo).
      });
    });

    container.querySelector('#btn-reset-pendientes')?.addEventListener('click', async () => {
      if (!isSignedIn()) {
        toast('Necesitás sesión de Google iniciada para reiniciar (borra también en Drive).');
        return;
      }
      const ok = await confirmDialog(
        `¿Reiniciar los pendientes de "${obra.name}"? Se borra TODO el historial de Checklist diario (con sus fotos) y de Avance programado, tanto de este teléfono como de Drive (queda recuperable desde la papelera de Drive por un tiempo). Personal en obra y Protocolos NO se tocan. Esta acción es para partir de cero — no se puede deshacer desde la app.`
      );
      if (!ok) return;

      const btn = container.querySelector('#btn-reset-pendientes');
      btn.disabled = true;
      btn.textContent = 'Reiniciando…';
      try {
        const result = await resetPendientes(obraId, obra);
        data = await loadData();
        toast(
          `Listo: se borraron ${result.checklistBorrados} checklist y ${result.snapshotsBorrados} programación(es)` +
          (result.driveFailed ? ` (${result.driveFailed} archivo(s) de Drive no se pudieron borrar, revisalo a mano).` : '.')
        );
        paint();
      } catch (err) {
        console.error('Error reiniciando pendientes:', err);
        toast('No se pudo reiniciar. Intenta de nuevo.');
        btn.disabled = false;
        btn.textContent = '🧹 Reiniciar pendientes de esta obra';
      }
    });

    container.querySelectorAll('.incumplimiento-resolve-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        // Lleva directo al ítem exacto (misma pestaña/día) para revisarlo
        // en contexto antes de resolverlo — no lo marca resuelto a ciegas
        // desde acá.
        const params = new URLSearchParams({
          type: btn.dataset.typeKey,
          date: btn.dataset.date,
          item: btn.dataset.itemIndex,
        });
        navigate(`/control/obra/${obraId}/checklist?${params.toString()}`);
      });
    });
  }

  paint();

  // Sincroniza en segundo plano (no bloquea el primer pintado) lo que haya
  // cargado el resto del equipo en Drive — si trae algo nuevo, refresca los
  // datos y vuelve a pintar. Nunca dispara el popup de sesión de Google
  // (isSignedIn evita eso; si el token venció, se salta calladito y el
  // usuario puede refrescar sesión desde cualquiera de las 3 secciones).
  const hasLinkedFolders = obra.checklistDriveFolderId || obra.personalDriveFolderId || obra.programacionDriveFolderId;
  if (hasLinkedFolders && isSignedIn()) {
    (async () => {
      try {
        const [c1, c2, c3] = await Promise.all([
          obra.checklistDriveFolderId ? syncChecklistFromDrive(obraId, obra.checklistDriveFolderId) : 0,
          obra.personalDriveFolderId ? syncSSMAFromDrive(obraId, obra.personalDriveFolderId) : 0,
          obra.programacionDriveFolderId ? syncAvanceFromDrive(obraId, obra.programacionDriveFolderId) : 0,
        ]);
        if (c1 || c2 || c3) {
          data = await loadData();
          toast('🔄 Dashboard actualizado con los últimos datos del equipo.');
          paint();
        }
      } catch (err) {
        console.error('Error sincronizando dashboard de Control:', err);
      }
    })();
  }
}
