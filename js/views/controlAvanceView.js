import { getObra, updateObra, addScheduleSnapshot, getScheduleSnapshotsByObra, deleteScheduleSnapshot } from '../db.js';
import { parseScheduleCSV, buildTaskTree } from '../controlScheduleParser.js';
import { openFolderPicker, listDriveCsvFiles, downloadDriveFile } from '../googleDrive.js';
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

  async function importCSVText(text, { driveFileId = null, driveFileName = null, uploadedAt } = {}) {
    const { tasks, overallPercent } = parseScheduleCSV(text);
    const snapshot = await addScheduleSnapshot({ obraId, tasks, overallPercent, driveFileId, driveFileName, ...(uploadedAt ? { uploadedAt } : {}) });
    snapshots = await getScheduleSnapshotsByObra(obraId);
    selectedSnapshotId = snapshot.id;
    return { tasks, overallPercent };
  }

  /**
   * Trae TODOS los .csv de la carpeta que todavía no se hayan importado (no
   * solo el más nuevo) — Pancho va dejando un archivo nuevo por revisión
   * ("Prog rev DD-MM-YYYY.csv"), así que cada uno es un punto real del
   * historial de avance, no un reemplazo del anterior. Cada snapshot usa la
   * fecha de modificación del archivo en Drive, no el momento de la
   * importación, para que el historial quede ordenado por revisión real.
   */
  async function checkDriveForNewProgramacion({ auto }) {
    if (!obra.programacionDriveFolderId) return;
    try {
      const files = await listDriveCsvFiles(obra.programacionDriveFolderId);
      if (!files.length) {
        if (!auto) toast('No hay ningún archivo .csv en esa carpeta de Drive todavía.');
        return;
      }
      const pending = files
        .filter((f) => !snapshots.some((s) => s.driveFileId === f.id))
        .sort((a, b) => new Date(a.modifiedTime) - new Date(b.modifiedTime));

      if (!pending.length) {
        if (!auto) toast('Ya tenés cargadas todas las programaciones de esa carpeta.');
        return;
      }

      let lastPercent = null;
      for (const file of pending) {
        const blob = await downloadDriveFile(file.id);
        const text = await readTextSmart(new File([blob], file.name));
        const result = await importCSVText(text, {
          driveFileId: file.id,
          driveFileName: file.name,
          uploadedAt: new Date(file.modifiedTime).getTime(),
        });
        lastPercent = result.overallPercent;
      }
      toast(pending.length === 1
        ? `📥 Nueva programación desde Drive: ${lastPercent}% de avance (${pending[0].name}).`
        : `📥 ${pending.length} programaciones nuevas importadas desde Drive.`);
      paint();
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
        <section class="avance-drive-link">
          ${obra.programacionDriveFolderId ? `
            <div class="avance-drive-linked">☁️ Carpeta vinculada: <strong>${escapeHTML(obra.programacionDriveFolderName)}</strong></div>
            <div class="avance-drive-actions">
              <button type="button" class="btn btn-primary" id="btn-check-drive">🔄 Buscar programación nueva</button>
              <button type="button" class="btn btn-secondary" id="btn-change-drive-folder">Cambiar carpeta</button>
            </div>
          ` : `
            <button type="button" class="btn btn-primary" id="btn-link-drive-folder">🔗 Vincular carpeta de Drive</button>
            <p class="avance-upload-hint">Elegí la carpeta donde vas dejando el CSV de la programación (la que ya armaste en Drive) — de ahí en adelante la app la revisa sola.</p>
          `}
        </section>

        <section class="avance-upload">
          <button type="button" class="btn btn-secondary" id="btn-upload-csv">📤 O subir un CSV a mano</button>
          <input type="file" id="avance-csv-input" accept=".csv,text/csv" hidden />
        </section>

        ${selected ? `
          <section class="avance-summary">
            <div class="avance-percent">${selected.overallPercent}%</div>
            <div class="avance-percent-label">avance general</div>
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

    const linkFolder = async () => {
      try {
        const picked = await openFolderPicker();
        if (!picked) return;
        await updateObra(obraId, { programacionDriveFolderId: picked.id, programacionDriveFolderName: picked.name });
        obra.programacionDriveFolderId = picked.id;
        obra.programacionDriveFolderName = picked.name;
        toast(`Carpeta vinculada: "${picked.name}".`);
        paint();
        checkDriveForNewProgramacion({ auto: false });
      } catch (err) {
        console.error(err);
        toast('No se pudo conectar con Google Drive.');
      }
    };
    container.querySelector('#btn-link-drive-folder')?.addEventListener('click', linkFolder);
    container.querySelector('#btn-change-drive-folder')?.addEventListener('click', linkFolder);
    container.querySelector('#btn-check-drive')?.addEventListener('click', () => checkDriveForNewProgramacion({ auto: false }));

    const csvInput = container.querySelector('#avance-csv-input');
    container.querySelector('#btn-upload-csv').addEventListener('click', () => csvInput.click());
    csvInput.addEventListener('change', async () => {
      const file = csvInput.files[0];
      csvInput.value = '';
      if (!file) return;
      try {
        const text = await readTextSmart(file);
        const { tasks, overallPercent } = await importCSVText(text);
        toast(`Programación cargada: ${tasks.length} tareas, ${overallPercent}% de avance.`);
        paint();
      } catch (err) {
        console.error('Error leyendo CSV de programación:', err);
        toast(err.message || 'No se pudo leer el archivo. Revisa que sea el CSV exportado de Project.');
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
