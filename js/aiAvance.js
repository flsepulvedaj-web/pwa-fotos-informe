import { getChildFolders, getPhotosByFolder, getPhotoCountByFolder } from './db.js';
import { downscaleImageBlob, blobToDataURL, escapeHTML, toast } from './utils.js';
import { signIn } from './googleDrive.js';
import { openExportReviewScreen } from './views/exportView.js';

const LAST_FORMAT_KEY = 'export-last-format';
const MAX_PHOTOS_PER_UNIT = 4; // tope de fotos por casa/depto que se manda a comparar (costo/tamaño del pedido)

// URL del Cloudflare Worker que hace la comparación con IA. Mientras no
// esté desplegado (Fase 4 del plan), queda en null y callAiAvanceBackend()
// usa un resultado simulado para poder construir y probar todo el resto
// del flujo sin depender del backend real.
const AI_BACKEND_URL = null; // TODO: reemplazar por la URL real del Worker

/**
 * ¿Esta carpeta está armada como grupo "Calle X" / "Piso Y" para el
 * informe de avance? Necesita una subcarpeta "Fotos ..." (las fotos
 * generales) y al menos una subcarpeta numerada (una casa o depto).
 */
export async function isAiAvanceGroup(folder) {
  if (!folder || !folder.id) return false;
  const children = await getChildFolders(folder.id);
  const hasFotosFolder = children.some((f) => /^fotos\s/i.test(f.name.trim()));
  const hasNumberedUnit = children.some((f) => /^\d+$/.test(f.name.trim()));
  return hasFotosFolder && hasNumberedUnit;
}

function pickRandom(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

async function prepareImageForAI(blob) {
  // Bastante más chica que la galería (1600px por defecto): para juzgar
  // avance de obra (pintura, piso, terminaciones sí/no) no hace falta
  // resolución alta, y así el pedido a la IA sale liviano y barato.
  const downscaled = await downscaleImageBlob(blob, 640, 0.75);
  const dataURL = await blobToDataURL(downscaled);
  return dataURL.replace(/^data:image\/\w+;base64,/, '');
}

async function callAiAvanceBackend(groupName, units, token) {
  if (!AI_BACKEND_URL) {
    console.warn('aiAvance: usando resultado simulado — AI_BACKEND_URL todavía no está configurada.');
    await new Promise((r) => setTimeout(r, 700)); // simula el tiempo de espera de una llamada real
    return {
      ranking: units.map((u) => u.unitFolderName),
      reasoning: '[Resultado simulado — el backend real de IA todavía no está conectado.]',
    };
  }

  if (!navigator.onLine) {
    const err = new Error('Sin conexión');
    err.offline = true;
    throw err;
  }

  const res = await fetch(AI_BACKEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ groupName, units }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Error comparando fotos (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Arma el arreglo final de 8 fotos en el orden que esperan los formatos
 * "casas-avance"/"depto-avance" (js/reportFormats.js): 2 fotos generales
 * (libres, tituladas con el nombre del grupo) + 3 de la unidad más
 * avanzada + 3 de la menos avanzada — todas elegidas al azar dentro de
 * cada carpeta, como pidió Pancho.
 *
 * El ranking se divide en dos mitades (mejor mitad / peor mitad) y cada
 * lado del informe solo puede rellenar fotos faltantes dentro de su
 * propia mitad — así una foto de la unidad menos avanzada nunca termina
 * ilustrando "más avance" ni viceversa, aunque el grupo tenga pocas
 * unidades fotografiadas.
 */
function buildFinalPhotoArray({ groupName, generalPhotos, ranking, photosByUnit }) {
  const substitutions = [];

  const generalPick = pickRandom(generalPhotos, 2).map((p) => ({ ...p, title: groupName }));

  function pickForSide(order, label) {
    const picked = [];
    const usedUnits = [];
    for (const unitName of order) {
      if (picked.length >= 3) break;
      const unitPhotos = photosByUnit.get(unitName) || [];
      if (!unitPhotos.length) continue;
      const need = 3 - picked.length;
      picked.push(...pickRandom(unitPhotos, need));
      usedUnits.push(unitName);
    }
    if (usedUnits.length > 1) {
      substitutions.push(
        `${label}: la unidad "${usedUnits[0]}" no tenía suficientes fotos — se completó con ${usedUnits.slice(1).map((u) => `"${u}"`).join(', ')}.`
      );
    }
    return picked;
  }

  const mid = Math.ceil(ranking.length / 2);
  const topHalf = ranking.slice(0, mid);
  const bottomHalf = ranking.slice(mid).reverse();

  const mostPicked = pickForSide(topHalf, 'Más avanzada');
  const leastPicked = pickForSide(bottomHalf.length ? bottomHalf : [ranking[ranking.length - 1]], 'Menos avanzada');

  return { finalPhotos: [...generalPick, ...mostPicked, ...leastPicked], substitutions };
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

function aiResultSheet({ groupName, ranking, reasoning, substitutions }) {
  const most = ranking[0];
  const least = ranking[ranking.length - 1];
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal ai-avance-result" role="dialog" aria-modal="true">
        <h2>Resultado de la IA — ${escapeHTML(groupName)}</h2>
        <p class="modal-message">
          <strong>Más avanzada:</strong> ${escapeHTML(most)}<br/>
          <strong>Menos avanzada:</strong> ${escapeHTML(least)}
        </p>
        ${reasoning ? `<p class="ai-avance-reasoning">${escapeHTML(reasoning)}</p>` : ''}
        ${substitutions.length ? `<ul class="ai-avance-substitutions">${substitutions.map((s) => `<li>${escapeHTML(s)}</li>`).join('')}</ul>` : ''}
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-action="cancel">Cancelar</button>
          <button type="button" class="btn btn-primary" data-action="confirm">Usar este resultado</button>
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
 * Punto de entrada del botón "🤖 Armar informe con IA" en una carpeta
 * "Calle X"/"Piso Y". Compara las unidades numeradas con IA, arma las 8
 * fotos del informe y abre la misma pantalla de revisión que ya usa el
 * resto de la app.
 */
export async function openAiAvanceFlow(folder) {
  const children = await getChildFolders(folder.id);
  const fotosFolder = children.find((f) => /^fotos\s/i.test(f.name.trim()));
  const unitFolders = children.filter((f) => /^\d+$/.test(f.name.trim()));

  const unitsWithCounts = await Promise.all(
    unitFolders.map(async (f) => ({ folder: f, count: await getPhotoCountByFolder(f.id) }))
  );
  const photographedUnits = unitsWithCounts.filter((u) => u.count > 0);

  if (photographedUnits.length < 2) {
    toast('Necesitás fotos de al menos 2 casas/deptos para usar esta función.');
    return;
  }

  const generalPhotos = fotosFolder ? await getPhotosByFolder(fotosFolder.id) : [];
  if (generalPhotos.length < 2) {
    toast(`"${fotosFolder ? fotosFolder.name : 'Fotos'}" necesita al menos 2 fotos generales.`);
    return;
  }

  const loadingOverlay = showLoadingOverlay('Comparando fotos con IA…');
  let result;
  try {
    const token = await signIn();
    const unitsPayload = await Promise.all(
      photographedUnits.map(async ({ folder: uf }) => {
        const photos = (await getPhotosByFolder(uf.id)).slice(0, MAX_PHOTOS_PER_UNIT);
        const encoded = await Promise.all(photos.map((p) => prepareImageForAI(p.blob)));
        return { unitFolderName: uf.name.trim(), photos: encoded };
      })
    );
    result = await callAiAvanceBackend(folder.name, unitsPayload, token);
  } catch (err) {
    console.error('Error comparando fotos con IA:', err);
    loadingOverlay.remove();
    toast(
      err.offline
        ? 'Necesitás internet para usar esta función — probá de nuevo cuando tengas señal.'
        : 'No se pudo comparar las fotos con la IA. Probá de nuevo.'
    );
    return;
  }
  loadingOverlay.remove();

  const { ranking, reasoning } = result || {};
  if (!ranking || ranking.length < 2) {
    toast('La IA no pudo determinar un resultado. Probá de nuevo.');
    return;
  }

  const photosByUnit = new Map();
  for (const { folder: uf } of photographedUnits) {
    photosByUnit.set(uf.name.trim(), await getPhotosByFolder(uf.id));
  }

  const { finalPhotos, substitutions } = buildFinalPhotoArray({
    groupName: folder.name,
    generalPhotos,
    ranking,
    photosByUnit,
  });

  const proceed = await aiResultSheet({ groupName: folder.name, ranking, reasoning, substitutions });
  if (!proceed) return;

  localStorage.setItem(LAST_FORMAT_KEY, /^piso\s/i.test(folder.name.trim()) ? 'depto-avance' : 'casas-avance');

  await openExportReviewScreen(finalPhotos, { name: folder.name, reportNumber: '', reportPeriod: '' });
}
