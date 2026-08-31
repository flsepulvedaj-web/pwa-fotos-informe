import { getObra, updateObra, addScheduleSnapshot, getScheduleSnapshotsByObra, deleteScheduleSnapshot } from '../db.js';
import { parseScheduleCSV, parseScheduleXLSX, buildTaskTree } from '../controlScheduleParser.js';
import { openFolderPicker, isSignedIn, getSignedInEmail } from '../googleDrive.js';
import { syncAvanceFromDrive } from '../controlSync.js';
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
 * Avance programado: se importa la programación como CSV exportado de
 * Project, ya sea subiéndolo a mano o vinculando una carpeta de Drive donde
 * Pancho la va dejando — cada importación crea un snapshot nuevo (no pisa
 * el anterior) así el dashboard puede graficar avance en el tiempo. Las
 * tareas atrasadas (fecha fin pasada y % < 100) quedan resaltadas.
 */
export async function renderControlAvanceView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  const admin = isAdmin(await getSignedInEmail());
  let snapshots = await getScheduleSnapshotsByObra(obraId);
  let selectedSnapshotId = snapshots[0]?.id || null;
  let tree = [];
  let collapsedSet = new Set();
  let treeBuiltForId = null; // evita reconstruir (y resetear los ▶/▼ abiertos) en cada repintado

  function ensureTreeForSelection() {
    if (treeBuiltForId === selectedSnapshotId) return;
    const selected = snapshots.find((s) => s.id === selectedSnapshotId);
    tree = selected ? buildTaskTree(selected.tasks) : [];
    collapsedSet = defaultCollapsedSet(tree);
    treeBuiltForId = selectedSnapshotId;
  }

  async function importParsed({ tasks, overallPercent }, { driveFileId = null, driveFileName = null, uploadedAt } = {}) {
    const snapshot = await addScheduleSnapshot({ obraId, tasks, overallPercent, driveFileId, driveFileName, ...(uploadedAt ? { uploadedAt } : {}) });
    snapshots = await getScheduleSnapshotsByObra(obraId);
    selectedSnapshotId = snapshot.id;
    return { tasks, overallPercent };
  }

  /**
   * Trae TODAS las programaciones nuevas de la carpeta vinculada (no solo
   * la más nueva) — Pancho/Sergio van dejando un archivo por revisión, así
   * que cada uno es un punto real del historial de avance. La lógica de
   * traer+parsear vive en controlSync.js, compartida con el Dashboard (que
   * también sincroniza al abrir la obra, sin tener que entrar acá).
   */
  async function checkDriveForNewProgramacion({ auto }) {
    if (!obra.programacionDriveFolderId) return;
    // El chequeo automático nunca debe disparar el popup de sesión de
    // Google — eso solo puede pasar desde un toque directo (botón).
    if (auto && !isSignedIn()) return;
    try {
      const count = await syncAvanceFromDrive(obraId, obra.programacionDriveFolderId);
      if (count) {
        snapshots = await getScheduleSnapshotsByObra(obraId);
        selectedSnapshotId = snapshots[0]?.id || null;
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
          folderId: obra.programacionDriveFolderId,
          folderName: obra.programacionDriveFolderName,
          syncLabel: '🔄 Buscar programación nueva',
          hintText: 'Elegí la carpeta donde vas dejando la programación (CSV o Excel, la que ya armaste en Drive) — de ahí en adelante la app la revisa sola.',
        })}

        <section class="avance-upload">
          <button type="button" class="btn btn-secondary" id="btn-upload-csv">📤 O subir la programación a mano (CSV o Excel)</button>
          <input type="file" id="avance-csv-input" accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" hidden />
        </section>

        ${selected ? `
          <section class="avance-summary">
            <div class="avance-percent">${selected.overallPercent}%</div>
            <div class="avance-percent-label">avance general</div>
            <div class="avance-updated-label${daysSince(selected.uploadedAt) > DAYS_STALE_WARNING ? ' avance-updated-stale' : ''}">
              Última programación: hace ${daysSince(selected.uploadedAt)} día(s)${daysSince(selected.uploadedAt) > DAYS_STALE_WARNING ? ' ⚠️ revisá si se subió la de esta semana' : ''}
            </div>
            ${atrasadas ? `<div class="checklist-alert">⚠️ ${atrasadas} tarea(s) atrasada(s)</div>` : ''}
          </section>

          <div class="avance-snapshot-picker">
            <label for="avance-snapshot-select">Programación cargada</label>
            <select id="avance-snapshot-select">
              ${snapshots.map((s) => `<option value="${s.id}" ${s.id === selectedSnapshotId ? 'selected' : ''}>${formatDateTime(s.uploadedAt)}${s.driveFileName ? ' (Drive)' : ''} — ${s.overallPercent}%</option>`).join('')}
            </select>
            <button type="button" class="icon-btn" id="btn-delete-snapshot" title="Eliminar esta programación">🗑️</button>
          </div>

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
        ` : `
          <div class="empty-state">
            <p>Todavía no has subido ninguna programación.</p>
            <p>Vinculá la carpeta de Drive o subí el CSV a mano con los botones de arriba.</p>
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
          await updateObra(obraId, { programacionDriveFolderId: picked.id, programacionDriveFolderName: picked.name });
          obra.programacionDriveFolderId = picked.id;
          obra.programacionDriveFolderName = picked.name;
          uploadObrasIndex(); // best-effort — le llega al resto del equipo sin esperar a que abran Control
          toast(`Carpeta vinculada: "${picked.name}".`);
          paint();
          checkDriveForNewProgramacion({ auto: false });
        } catch (err) {
          console.error(err);
          toast('No se pudo conectar con Google Drive.');
        }
      },
      onSync: () => checkDriveForNewProgramacion({ auto: false }),
    });

    const csvInput = container.querySelector('#avance-csv-input');
    container.querySelector('#btn-upload-csv').addEventListener('click', () => csvInput.click());
    csvInput.addEventListener('change', async () => {
      const file = csvInput.files[0];
      csvInput.value = '';
      if (!file) return;
      try {
        const isExcel = /\.(xlsx|xls)$/i.test(file.name);
        const parsed = isExcel
          ? parseScheduleXLSX(await file.arrayBuffer())
          : parseScheduleCSV(await readTextSmart(file));
        const { tasks, overallPercent } = await importParsed(parsed);
        toast(`Programación cargada: ${tasks.length} tareas, ${overallPercent}% de avance.`);
        paint();
      } catch (err) {
        console.error('Error leyendo el archivo de programación:', err);
        toast(err.message || 'No se pudo leer el archivo. Revisa que sea el CSV o Excel exportado de Project.');
      }
    });

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
      snapshots = await getScheduleSnapshotsByObra(obraId);
      selectedSnapshotId = snapshots[0]?.id || null;
      toast('Programación eliminada.');
      paint();
    });
  }

  paint();

  if (obra.programacionDriveFolderId) {
    checkDriveForNewProgramacion({ auto: true });
  }
}
