import { getObra, updateObra, addScheduleSnapshot, getScheduleSnapshotsByObra, deleteScheduleSnapshot } from '../db.js';
import { parseScheduleCSV } from '../controlScheduleParser.js';
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

  async function importCSVText(text, { driveFileId = null, driveFileName = null } = {}) {
    const { tasks, overallPercent } = parseScheduleCSV(text);
    const snapshot = await addScheduleSnapshot({ obraId, tasks, overallPercent, driveFileId, driveFileName });
    snapshots = await getScheduleSnapshotsByObra(obraId);
    selectedSnapshotId = snapshot.id;
    return { tasks, overallPercent };
  }

  async function checkDriveForNewProgramacion({ auto }) {
    if (!obra.programacionDriveFolderId) return;
    try {
      const files = await listDriveCsvFiles(obra.programacionDriveFolderId);
      if (!files.length) {
        if (!auto) toast('No hay ningún archivo .csv en esa carpeta de Drive todavía.');
        return;
      }
      const newest = files[0]; // listDriveCsvFiles ya ordena por modifiedTime desc
      const alreadyImported = snapshots.some((s) => s.driveFileId === newest.id);
      if (alreadyImported) {
        if (!auto) toast('Ya tenés cargada la programación más reciente de esa carpeta.');
        return;
      }
      const blob = await downloadDriveFile(newest.id);
      const text = await readTextSmart(new File([blob], newest.name));
      const { overallPercent } = await importCSVText(text, { driveFileId: newest.id, driveFileName: newest.name });
      toast(`📥 Nueva programación desde Drive: ${overallPercent}% de avance (${newest.name}).`);
      paint();
    } catch (err) {
      console.error('Error buscando programación en Drive:', err);
      if (!auto) toast('No se pudo conectar con Drive.');
    }
  }

  function paint() {
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

          <div class="avance-table-wrap">
            <table class="avance-table">
              <thead>
                <tr><th>Tarea</th><th>Inicio</th><th>Fin</th><th>%</th></tr>
              </thead>
              <tbody>
                ${selected.tasks.map((t) => `
                  <tr class="${isAtrasada(t) ? 'avance-row-atrasada' : ''}">
                    <td>${escapeHTML(t.name)}</td>
                    <td>${formatDateEs(t.plannedStart)}</td>
                    <td>${formatDateEs(t.plannedEnd)}</td>
                    <td>${t.plannedPercent}%</td>
                  </tr>
                `).join('')}
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
