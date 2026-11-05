import { getChildFolders, getPhotoCountByFolderRecursive, getPhotoGroupsRecursive } from './db.js';
import { downscaleImageBlob, blobToDataURL, escapeHTML, toast, confirmDialog } from './utils.js';
import { signIn } from './googleDrive.js';
import { openExportReviewScreen } from './views/exportView.js';

// Informe fotográfico automático: recorre TODAS las carpetas con fotos de una
// obra, deja aparte las fachadas (la IA revisa cuáles lo son) y elige cuántas
// fotos mostrar de cada carpeta según cuántas tenga:
//   16 o más -> 16 · de 8 a 15 -> 8 · menos de 8 -> todas.
// Las fotos se reparten parejo en el tiempo, para cubrir toda la carpeta.

const LAST_FORMAT_KEY = 'export-last-format';
const FACADE_BATCH_SIZE = 24; // fotos por llamada a la IA (tope del backend: 30)
const FACADE_PARALLEL_CALLS = 3;
const FACADE_TITLE = 'Fachada';

// Mismo Worker de Cloudflare que usa "Armar informe con IA"
// (vizor-reports-ai-backend/worker.js, ruta /classify-facades).
const FACADE_URL = 'https://vizor-reports-ai-avance.flsepulvedaj.workers.dev/classify-facades';

/** Cuántas fotos se muestran de una carpeta que tiene n. */
export function takeCountFor(n) {
  if (n >= 16) return 16;
  if (n >= 8) return 8;
  return n;
}

/** k fotos repartidas parejo entre todas (ordenadas por hora de toma). */
export function spreadPick(photos, k) {
  const sorted = [...photos].sort((a, b) => a.createdAt - b.createdAt);
  if (k >= sorted.length) return sorted;
  if (k <= 0) return [];
  if (k === 1) return [sorted[Math.floor(sorted.length / 2)]];
  const picked = [];
  const used = new Set();
  for (let i = 0; i < k; i++) {
    let idx = Math.round((i * (sorted.length - 1)) / (k - 1));
    while (used.has(idx) && idx < sorted.length - 1) idx++;
    used.add(idx);
    picked.push(sorted[idx]);
  }
  return picked;
}

/** Zócalo, Piso 1, 2, 3…, el resto en orden alfabético y "Otros" al final. */
function groupOrderKey(name) {
  const n = name.trim().toLowerCase();
  if (/^z[oó]calo$/.test(n)) return [0, 0, n];
  const floor = n.match(/^piso\s+(-?\d+)/);
  if (floor) return [1, Number(floor[1]), n];
  if (n === 'otros') return [3, 0, n];
  return [2, 0, n];
}

function compareGroups(a, b) {
  const ka = groupOrderKey(a.label);
  const kb = groupOrderKey(b.label);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2], 'es');
}

/**
 * ¿Esta carpeta se puede usar como "obra" para el informe automático? Necesita
 * al menos 2 subcarpetas con fotos adentro.
 */
export async function isPhotoReportGroup(folder) {
  if (!folder || !folder.id) return false;
  const children = await getChildFolders(folder.id);
  let withPhotos = 0;
  for (const c of children) {
    if ((await getPhotoCountByFolderRecursive(c.id)) > 0) withPhotos++;
    if (withPhotos >= 2) return true;
  }
  return false;
}

async function prepareImageForAI(blob) {
  const downscaled = await downscaleImageBlob(blob, 512, 0.7);
  const dataURL = await blobToDataURL(downscaled);
  return dataURL.replace(/^data:image\/\w+;base64,/, '');
}

async function classifyFacadeBatch(photos, token) {
  const payload = await Promise.all(
    photos.map(async (p, i) => ({ id: String(i + 1), data: await prepareImageForAI(p.blob) }))
  );
  const res = await fetch(FACADE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ photos: payload }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let reason = text;
    try {
      reason = JSON.parse(text).error || text;
    } catch {
      // no era JSON
    }
    const err = new Error(reason || `Error revisando fachadas (${res.status})`);
    err.notDeployed = res.status === 404;
    throw err;
  }
  const data = await res.json();
  const ids = Array.isArray(data.facadeIds) ? data.facadeIds : [];
  return ids.map((id) => photos[Number(id) - 1]).filter(Boolean);
}

/**
 * Revisa todas las fotos con la IA en lotes. Devuelve { facades, failedBatches,
 * firstError }: las fotos que son fachada y cuántos lotes no se pudieron revisar.
 */
async function detectFacades(allPhotos, token, onProgress) {
  const batches = [];
  for (let i = 0; i < allPhotos.length; i += FACADE_BATCH_SIZE) batches.push(allPhotos.slice(i, i + FACADE_BATCH_SIZE));
  const facades = [];
  let failedBatches = 0;
  let firstError = null;
  let done = 0;
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        facades.push(...(await classifyFacadeBatch(batch, token)));
      } catch (err) {
        console.error('Error revisando fachadas con IA:', err);
        failedBatches++;
        if (!firstError) firstError = err;
      }
      done++;
      onProgress(done, batches.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(FACADE_PARALLEL_CALLS, batches.length) }, worker));
  return { facades, failedBatches, firstError };
}

function showLoadingOverlay(message) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay ai-avance-loading';
  overlay.innerHTML = `
    <div class="ai-avance-spinner-box">
      <div class="ai-avance-spinner"></div>
      <p>${escapeHTML(message)}</p>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function summarySheet({ folderName, rows, facadeTotal, facadeShown, failedBatches }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const rowsHTML = rows
      .map((r) => `<li><strong>${escapeHTML(r.name)}</strong>: ${r.shown} de ${r.available} foto${r.available === 1 ? '' : 's'}</li>`)
      .join('');
    const total = rows.reduce((s, r) => s + r.shown, 0) + facadeShown;
    overlay.innerHTML = `
      <div class="modal ai-avance-result ai-avance-multi" role="dialog" aria-modal="true">
        <h2>Informe fotográfico — ${escapeHTML(folderName)}</h2>
        <p class="modal-message">La IA encontró <strong>${facadeTotal}</strong> foto${facadeTotal === 1 ? '' : 's'} de fachada${facadeShown < facadeTotal ? ` (se usan ${facadeShown})` : ''}, que van primero.</p>
        ${failedBatches ? `<p class="modal-message">⚠️ ${failedBatches} grupo${failedBatches === 1 ? '' : 's'} de fotos no se pudo revisar; esas fotos quedan en su carpeta.</p>` : ''}
        <ul class="ai-avance-substitutions">
          ${facadeShown ? `<li><strong>${FACADE_TITLE}</strong>: ${facadeShown} fotos</li>` : ''}
          ${rowsHTML}
        </ul>
        <p class="modal-message">Total: ${total} fotos. En la pantalla siguiente puedes quitar o cambiar las que quieras.</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-action="cancel">Cancelar</button>
          <button type="button" class="btn btn-primary" data-action="confirm">Armar informe</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    function cleanup(result) {
      overlay.remove();
      resolve(result);
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
      const btn = e.target.closest('[data-action]');
      if (btn) cleanup(btn.dataset.action === 'confirm');
    });
  });
}

/**
 * Punto de entrada de "Informe fotográfico automático" en una carpeta de obra.
 */
export async function openAutoPhotoReportFlow(folder) {
  const groups = await getPhotoGroupsRecursive(folder.id);
  const allPhotos = groups.flatMap((g) => g.photos);
  if (!allPhotos.length) {
    toast('Esta carpeta no tiene fotos.');
    return;
  }

  let token;
  try {
    token = await signIn();
  } catch (err) {
    console.error(err);
    toast('No se pudo conectar con Google.');
    return;
  }

  let facades = [];
  let failedBatches = 0;
  if (!navigator.onLine) {
    if (!(await confirmDialog('No hay internet, así que la IA no puede revisar las fachadas. ¿Armar el informe igual, sin fachadas?'))) return;
  } else {
    const overlay = showLoadingOverlay(`Revisando fachadas con IA (0 de ${Math.ceil(allPhotos.length / FACADE_BATCH_SIZE)})…`);
    let result;
    try {
      result = await detectFacades(allPhotos, token, (done, total) => {
        const p = overlay.querySelector('p');
        if (p) p.textContent = `Revisando fachadas con IA (${done} de ${total})…`;
      });
    } finally {
      overlay.remove();
    }
    facades = result.facades;
    failedBatches = result.failedBatches;
    if (result.failedBatches === Math.ceil(allPhotos.length / FACADE_BATCH_SIZE)) {
      const why = result.firstError?.notDeployed
        ? 'El servidor de IA todavía no tiene la función de fachadas.'
        : (result.firstError?.message || 'No se pudo usar la IA.');
      if (!(await confirmDialog(`${why} ¿Armar el informe igual, sin fachadas?`))) return;
      facades = [];
    }
  }

  const facadeIds = new Set(facades.map((p) => p.id));
  const facadeShown = spreadPick(facades, takeCountFor(facades.length)).map((p) => ({ ...p, title: FACADE_TITLE, freeSlot: true }));

  const rows = [];
  const folderPhotos = []; // un arreglo de fotos por carpeta
  for (const g of [...groups].sort(compareGroups)) {
    const pool = g.photos.filter((p) => !facadeIds.has(p.id));
    if (!pool.length) continue;
    const picked = spreadPick(pool, takeCountFor(pool.length));
    rows.push({ name: g.label, available: pool.length, shown: picked.length, photos: picked.map((p) => ({ ...p, title: g.label, freeSlot: true })) });
  }
  // Las carpetas con menos de 8 fotos van al final, para tener que rellenar
  // lo menos posible.
  rows.sort((a, b) => Number(a.shown % 8 !== 0) - Number(b.shown % 8 !== 0));
  for (const r of rows) folderPhotos.push(r.photos);

  const confirmed = await summarySheet({
    folderName: folder.name,
    rows,
    facadeTotal: facades.length,
    facadeShown: facadeShown.length,
    failedBatches,
  });
  if (!confirmed) return;

  // Cada bloque (Fachada y cada carpeta) parte en una hoja nueva: el informe
  // pone 8 fotos por hoja seguidas, así que a los bloques que no completan 8
  // se les agregan casilleros en blanco. El último no necesita.
  const blocks = [facadeShown, ...folderPhotos].filter((b) => b.length);
  const spacerBlob = blocks.some((b, i) => i < blocks.length - 1 && b.length % 8) ? await makeBlankPhotoBlob() : null;
  let spacerCount = 0;
  const finalPhotos = [];
  blocks.forEach((block, i) => {
    finalPhotos.push(...block);
    if (i === blocks.length - 1) return;
    for (let pad = (8 - (block.length % 8)) % 8; pad > 0; pad--) {
      finalPhotos.push({ id: `blank-${++spacerCount}`, blob: spacerBlob, title: '', note: '', createdAt: 0, freeSlot: true, blank: true });
    }
  });

  localStorage.setItem(LAST_FORMAT_KEY, 'libre');
  await openExportReviewScreen(finalPhotos, { name: folder.name, reportNumber: '', reportPeriod: '' });
}

/** Imagen blanca 4:3 para rellenar casilleros vacíos de una hoja. */
function makeBlankPhotoBlob() {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    canvas.toBlob(resolve, 'image/jpeg', 0.8);
  });
}
