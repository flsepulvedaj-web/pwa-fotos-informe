import { getObra, updateObra, addScheduleSnapshot, getScheduleSnapshotsByObraAndType, deleteScheduleSnapshot } from '../db.js';
import { parseScheduleCSV, parseScheduleXLSX, buildTaskTree } from '../controlScheduleParser.js';
import { renderGanttChartHTML } from '../ganttChart.js';
import { openFolderPicker, isSignedIn, signIn, getSignedInEmail } from '../googleDrive.js';
import { syncAvanceFromDrive } from '../controlSync.js';
import { parseMPPViaBackend, isMppBackendConfigured } from '../mppBackend.js';
import { uploadObrasIndex } from '../obraSync.js';
import { isAdmin } from '../permissions.js';
import { driveLinkSectionHTML, wireDriveLinkSection } from '../driveLinkSection.js';
import { navigate } from '../router.js';
import { escapeHTML, confirmDialog, toast } from '../utils.js';

function formatDateTime(ts) {
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
}

function formatDateEs(iso) {
  if (!iso) return '—';
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * Project exporta el CSV en "Windows (ANSI)" por defecto, no UTF-8 — leído
 * como UTF-8 directo, las tildes y la ñ salen mal. Se intenta UTF-8 primero
 * (lo normal si alguien lo reguarda desde Excel) y si aparece el caracter
 * de reemplazo (texto corrupto), se reintenta como Windows-1252 (ANSI).
 */
async function readTextSmart(file) {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (utf8.includes('�')) {
    return new TextDecoder('windows-1252').decode(buf);
  }
  return utf8;
}

// `new Date('2026-08-20')` parsea como medianoche UTC, no hora local — en
// Chile (UTC-3/-4) eso cae en la tarde/noche del día ANTERIOR, así que
// comparado contra la medianoche local de "hoy" una tarea que vence hoy
// mismo salía marcada como atrasada un día antes de tiempo. Se arma la
// fecha con los componentes locales en vez de parsear el string ISO.
function parseLocalDate(iso) {
  const [yyyy, mm, dd] = iso.split('-').map(Number);
  return new Date(yyyy, mm - 1, dd);
}

function isAtrasada(task) {
  if (!task.plannedEnd) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parseLocalDate(task.plannedEnd) < today && task.plannedPercent < 100;
}

// La programación se sube una vez por semana (martes) — si pasaron más de
// 8 días desde la última, probablemente se saltaron una subida.
const DAYS_STALE_WARNING = 8;

function daysSince(ts) {
  return Math.floor((Date.now() - ts) / 86400000);
}

function countAtrasadasInside(node) {
  let count = isAtrasada(node.task) ? 1 : 0;
  for (const child of node.children) count += countAtrasadasInside(child);
  return count;
}

/** Colapsado por defecto: el nivel raíz queda abierto (se ven las partidas
 * principales de un vistazo), todo lo que está más adentro arranca cerrado
 * — así la tabla parte mostrando un resumen, no las ~130 tareas sueltas. */
function defaultCollapsedSet(tree) {
  const collapsed = new Set();
  function walk(nodes, depth) {
    for (const node of nodes) {
      if (node.children.length && depth >= 1) collapsed.add(node.index);
      walk(node.children, depth + 1);
    }
  }
  walk(tree, 0);
  return collapsed;
}

function renderTaskTreeRows(nodes, depth, collapsedSet) {
  return nodes.map((node) => {
    const hasChildren = node.children.length > 0;
    const collapsed = collapsedSet.has(node.index);
    const atrasadasInside = hasChildren && collapsed ? countAtrasadasInside(node) : 0;
    const rowClasses = [
      isAtrasada(node.task) ? 'avance-row-atrasada' : '',
      hasChildren ? 'avance-row-summary' : '',
    ].filter(Boolean).join(' ');

    let html = `
      <tr class="${rowClasses}">
        <td style="padding-left:${depth * 16 + 10}px">
          ${hasChildren ? `<button type="button" class="avance-toggle-btn" data-toggle-index="${node.index}">${collapsed ? '▶' : '▼'}</button>` : ''}
          ${escapeHTML(node.task.name)}
          ${atrasadasInside ? `<span class="avance-badge-atrasada">⚠️ ${atrasadasInside}</span>` : ''}
        </td>
        <td>${formatDateEs(node.task.plannedStart)}</td>
        <td>${formatDateEs(node.task.plannedEnd)}</td>
        <td>${node.task.plannedPercent}%</td>
      </tr>
    `;
    if (hasChildren && !collapsed) {
      html += renderTaskTreeRows(node.children, depth + 1, collapsedSet);
    }
    return html;
  }).join('');
}

/**
 * Avance programado: Pancho lleva 2 programaciones de Project por obra —
 * "Proyectada" (el plan original) y "Física Real" (el avance de verdad en
 * terreno) — cada una con su propia carpeta de Drive. El listado/tabla de
 * tareas SOLO muestra Física Real (es la que se revisa en el día a día);
 * Proyectada no se lista, solo alimenta la Curva S del dashboard
 * (controlDashboard.js / controlObraView.js) que compara ambas en el
 * tiempo. Cada importación crea un snapshot nuevo (no pisa el anterior).
 */
export async function renderControlAvanceView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  const admin = isAdmin(await getSignedInEmail());
  // Solo Física Real se lista/tabula — Proyectada se sigue guardando (para
  // la Curva S) pero no aparece acá.
  let snapshots = await getScheduleSnapshotsByObraAndType(obraId, 'real');
  let selectedSnapshotId = snapshots[0]?.id || null;
  let tree = [];
  let collapsedSet = new Set();
  let treeBuiltForId = null; // evita reconstruir (y resetear los ▶/▼ abiertos) en cada repintado
  let viewMode = 'tabla'; // 'tabla' | 'gantt'

  function ensureTreeForSelection() {
    if (treeBuiltForId === selectedSnapshotId) return;
    const selected = snapshots.find((s) => s.id === selectedSnapshotId);
    tree = selected ? buildTaskTree(selected.tasks) : [];
    collapsedSet = defaultCollapsedSet(tree);
    treeBuiltForId = selectedSnapshotId;
  }

  async function importParsed({ tasks, overallPercent }, scheduleType, { driveFileId = null, driveFileName = null, uploadedAt } = {}) {
    const snapshot = await addScheduleSnapshot({ obraId, tasks, overallPercent, scheduleType, driveFileId, driveFileName, ...(uploadedAt ? { uploadedAt } : {}) });
    snapshots = await getScheduleSnapshotsByObraAndType(obraId, 'real');
    if (scheduleType === 'real') selectedSnapshotId = snapshot.id;
    return { tasks, overallPercent };
  }

  /**
   * Trae TODAS las programaciones nuevas de la carpeta vinculada de un tipo
   * (no solo la más nueva) — Pancho/Sergio van dejando un archivo por
   * revisión, así que cada uno es un punto real del historial. La lógica de
   * traer+parsear vive en controlSync.js, compartida con el Dashboard (que
   * también sincroniza ambos tipos al abrir la obra, sin entrar acá).
   */
  async function checkDriveForNewProgramacion(scheduleType, { auto }) {
    const folderId = scheduleType === 'real' ? obra.programacionDriveFolderId : obra.programacionProyectadaDriveFolderId;
    if (!folderId) return;
    // El chequeo automático nunca debe disparar el popup de sesión de
    // Google — eso solo puede pasar desde un toque directo (botón).
    if (auto && !isSignedIn()) return;
    try {
      // Si hay algún .mpp en la carpeta, syncAvanceFromDrive lo manda al
      // servidor propio — necesita el token. `signIn()` no muestra el
      // popup si ya había sesión (que es justo lo que `isSignedIn()` ya
      // confirmó arriba para el chequeo automático).
      const parseMPP = isMppBackendConfigured()
        ? async (blob) => parseMPPViaBackend(blob, await signIn())
        : null;
      const count = await syncAvanceFromDrive(obraId, folderId, scheduleType, parseMPP);
      if (count) {
        snapshots = await getScheduleSnapshotsByObraAndType(obraId, 'real');
        if (scheduleType === 'real') selectedSnapshotId = snapshots[0]?.id || null;
        toast(count === 1 ? '📥 Nueva programación importada desde Drive.' : `📥 ${count} programaciones nuevas importadas desde Drive.`);
        paint();
      } else if (!auto) {
        toast('Ya tenés cargadas todas las programaciones de esa carpeta.');
      }
    } catch (err) {
      console.error('Error buscando programación en Drive:', err);
      if (!auto) toast('No se pudo conectar con Drive.');
    }
  }

  async function handleFileUpload(file, scheduleType) {
    try {
      const isExcel = /\.(xlsx|xls)$/i.test(file.name);
      const isMpp = /\.mpp$/i.test(file.name);
      let parsed;
      if (isMpp) {
        // Pide sesión primero (mismo patrón que aiAvance.js): el servidor
        // necesita el token de Google para confirmar que sos vos.
        let token;
        try {
          token = await signIn();
        } catch (err) {
          console.error(err);
          toast('No se pudo conectar con Google.');
          return;
        }
        parsed = await parseMPPViaBackend(file, token);
      } else if (isExcel) {
        parsed = parseScheduleXLSX(await file.arrayBuffer());
      } else {
        parsed = parseScheduleCSV(await readTextSmart(file));
      }
      const { tasks, overallPercent } = await importParsed(parsed, scheduleType);
      toast(`Programación (${scheduleType === 'real' ? 'Física Real' : 'Proyectada'}) cargada: ${tasks.length} tareas, ${overallPercent}% de avance.`);
      paint();
    } catch (err) {
      console.error('Error leyendo el archivo de programación:', err);
      toast(err.message || 'No se pudo leer el archivo. Revisa que sea el CSV o Excel exportado de Project.');
    }
  }

  function paint() {
    ensureTreeForSelection();
    const selected = snapshots.find((s) => s.id === selectedSnapshotId);
    const atrasadas = selected ? selected.tasks.filter(isAtrasada).length : 0;

    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Avance — ${escapeHTML(obra.name)}</span>
      </header>
      <main class="view-content">
        ${driveLinkSectionHTML({
          admin,
          idPrefix: 'real-',
          title: '📍 Física Real',
          folderId: obra.programacionDriveFolderId,
          folderName: obra.programacionDriveFolderName,
          syncLabel: '🔄 Buscar programación nueva',
          hintText: 'Elegí la carpeta donde vas dejando la programación FÍSICA REAL (CSV o Excel) — de ahí en adelante la app la revisa sola.',
        })}
        <section class="avance-upload">
          <button type="button" class="btn btn-secondary" id="btn-upload-real">📤 O subir Física Real a mano (.mpp, CSV o Excel)</button>
          <input type="file" id="real-csv-input" accept=".mpp,.csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" hidden />
        </section>

        ${driveLinkSectionHTML({
          admin,
          idPrefix: 'proyectada-',
          title: '🎯 Proyectada',
          folderId: obra.programacionProyectadaDriveFolderId,
          folderName: obra.programacionProyectadaDriveFolderName,
          syncLabel: '🔄 Buscar programación nueva',
          hintText: 'Elegí la carpeta donde vas dejando la programación PROYECTADA (el plan original) — solo alimenta la Curva S del dashboard, no aparece en la tabla de abajo.',
        })}
        <section class="avance-upload">
          <button type="button" class="btn btn-secondary" id="btn-upload-proyectada">📤 O subir Proyectada a mano (.mpp, CSV o Excel)</button>
          <input type="file" id="proyectada-csv-input" accept=".mpp,.csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" hidden />
        </section>

        ${selected ? `
          <section class="avance-summary">
            <div class="avance-percent">${selected.overallPercent}%</div>
            <div class="avance-percent-label">avance físico real</div>
            <div class="avance-updated-label${daysSince(selected.uploadedAt) > DAYS_STALE_WARNING ? ' avance-updated-stale' : ''}">
              Última programación: hace ${daysSince(selected.uploadedAt)} día(s)${daysSince(selected.uploadedAt) > DAYS_STALE_WARNING ? ' ⚠️ revisá si se subió la de esta semana' : ''}
            </div>
            ${atrasadas ? `<div class="checklist-alert">⚠️ ${atrasadas} tarea(s) atrasada(s)</div>` : ''}
          </section>

          <div class="avance-snapshot-picker">
            <label for="avance-snapshot-select">Programación cargada (Física Real)</label>
            <select id="avance-snapshot-select">
              ${snapshots.map((s) => `<option value="${s.id}" ${s.id === selectedSnapshotId ? 'selected' : ''}>${formatDateTime(s.uploadedAt)}${s.driveFileName ? ' (Drive)' : ''} — ${s.overallPercent}%</option>`).join('')}
            </select>
            <button type="button" class="icon-btn" id="btn-delete-snapshot" title="Eliminar esta programación">🗑️</button>
          </div>

          <div class="ssma-form-actions">
            <button type="button" class="btn btn-secondary" id="btn-view-tabla" ${viewMode === 'tabla' ? 'disabled' : ''}>📋 Tabla</button>
            <button type="button" class="btn btn-secondary" id="btn-view-gantt" ${viewMode === 'gantt' ? 'disabled' : ''}>📊 Carta Gantt</button>
          </div>

          ${viewMode === 'tabla' ? `
            <p class="avance-tree-hint">Negrita = partida principal (agrupa las tareas de abajo). Tocá ▶ para abrir el detalle.</p>
            <div class="avance-table-wrap">
              <table class="avance-table">
                <thead>
                  <tr><th>Tarea</th><th>Inicio</th><th>Fin</th><th>%</th></tr>
                </thead>
                <tbody>
                  ${renderTaskTreeRows(tree, 0, collapsedSet)}
                </tbody>
              </table>
            </div>
          ` : (() => {
            const ganttHTML = renderGanttChartHTML(tree, collapsedSet);
            return ganttHTML || '<div class="empty-state"><p>Ninguna tarea visible tiene fecha de inicio y fin para graficar.</p></div>';
          })()}
        ` : `
          <div class="empty-state">
            <p>Todavía no has subido ninguna programación Física Real.</p>
            <p>Vinculá la carpeta de Drive o subila a mano con los botones de arriba.</p>
          </div>
        `}
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate(`/control/obra/${obraId}`));

    wireDriveLinkSection(container, {
      idPrefix: 'real-',
      onLink: async () => {
        try {
          const picked = await openFolderPicker();
          if (!picked) return;
          await updateObra(obraId, { programacionDriveFolderId: picked.id, programacionDriveFolderName: picked.name });
          obra.programacionDriveFolderId = picked.id;
          obra.programacionDriveFolderName = picked.name;
          uploadObrasIndex();
          toast(`Carpeta vinculada: "${picked.name}".`);
          paint();
          checkDriveForNewProgramacion('real', { auto: false });
        } catch (err) {
          console.error(err);
          toast('No se pudo conectar con Google Drive.');
        }
      },
      onSync: () => checkDriveForNewProgramacion('real', { auto: false }),
    });

    wireDriveLinkSection(container, {
      idPrefix: 'proyectada-',
      onLink: async () => {
        try {
          const picked = await openFolderPicker();
          if (!picked) return;
          await updateObra(obraId, { programacionProyectadaDriveFolderId: picked.id, programacionProyectadaDriveFolderName: picked.name });
          obra.programacionProyectadaDriveFolderId = picked.id;
          obra.programacionProyectadaDriveFolderName = picked.name;
          uploadObrasIndex();
          toast(`Carpeta vinculada: "${picked.name}".`);
          paint();
          checkDriveForNewProgramacion('proyectada', { auto: false });
        } catch (err) {
          console.error(err);
          toast('No se pudo conectar con Google Drive.');
        }
      },
      onSync: () => checkDriveForNewProgramacion('proyectada', { auto: false }),
    });

    const realInput = container.querySelector('#real-csv-input');
    container.querySelector('#btn-upload-real').addEventListener('click', () => realInput.click());
    realInput.addEventListener('change', async () => {
      const file = realInput.files[0];
      realInput.value = '';
      if (file) await handleFileUpload(file, 'real');
    });

    const proyectadaInput = container.querySelector('#proyectada-csv-input');
    container.querySelector('#btn-upload-proyectada').addEventListener('click', () => proyectadaInput.click());
    proyectadaInput.addEventListener('change', async () => {
      const file = proyectadaInput.files[0];
      proyectadaInput.value = '';
      if (file) await handleFileUpload(file, 'proyectada');
    });

    container.querySelector('#btn-view-tabla')?.addEventListener('click', () => { viewMode = 'tabla'; paint(); });
    container.querySelector('#btn-view-gantt')?.addEventListener('click', () => { viewMode = 'gantt'; paint(); });

    container.querySelector('#avance-snapshot-select')?.addEventListener('change', (e) => {
      selectedSnapshotId = e.target.value;
      paint();
    });

    container.querySelector('.avance-table-wrap')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.avance-toggle-btn');
      if (!btn) return;
      const idx = Number(btn.dataset.toggleIndex);
      if (collapsedSet.has(idx)) collapsedSet.delete(idx);
      else collapsedSet.add(idx);
      paint();
    });

    container.querySelector('#btn-delete-snapshot')?.addEventListener('click', async () => {
      const ok = await confirmDialog('¿Eliminar esta programación cargada? No se puede deshacer.');
      if (!ok) return;
      await deleteScheduleSnapshot(selectedSnapshotId);
      snapshots = await getScheduleSnapshotsByObraAndType(obraId, 'real');
      selectedSnapshotId = snapshots[0]?.id || null;
      toast('Programación eliminada.');
      paint();
    });
  }

  paint();

  if (obra.programacionDriveFolderId) {
    checkDriveForNewProgramacion('real', { auto: true });
  }
  if (obra.programacionProyectadaDriveFolderId) {
    checkDriveForNewProgramacion('proyectada', { auto: true });
  }
}
