import { getChildFolders, getPhotosByFolder, getPhotoCountByFolder, getFolder } from './db.js';
import { downscaleImageBlob, blobToDataURL, escapeHTML, toast } from './utils.js';
import { signIn } from './googleDrive.js';
import { openExportReviewScreen } from './views/exportView.js';

const LAST_FORMAT_KEY = 'export-last-format';
const MAX_PHOTOS_PER_UNIT = 4; // tope de fotos por casa/depto que se manda a comparar (costo/tamaño del pedido)

// URL del Cloudflare Worker que hace la comparación con IA (ver
// vizor-reports-ai-backend/ — proyecto aparte de este repo).
const AI_BACKEND_URL = 'https://vizor-reports-ai-avance.flsepulvedaj.workers.dev/compare-progress';

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
    // El Worker devuelve {"error":"..."} — mostramos ese motivo real (ej.
    // "correo no autorizado", "límite diario alcanzado") en vez de un
    // mensaje genérico, para poder diagnosticar sin tener que ir a mirar
    // los logs de Cloudflare cada vez.
    let reason = text;
    try {
      reason = JSON.parse(text).error || text;
    } catch {
      // no era JSON, se usa el texto tal cual
    }
    throw new Error(reason || `Error comparando fotos (${res.status})`);
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

function updateLoadingMessage(overlay, message) {
  const p = overlay.querySelector('p');
  if (p) p.textContent = message;
}

/**
 * Nombre por defecto para el campo "Obra" de un informe combinado. Si
 * todas las carpetas elegidas comparten la misma carpeta madre (ej. varios
 * "Piso X TS" adentro de "Torre Sur"), usa el nombre de esa madre — mucho
 * más corto y sensato que encadenar los 15 nombres de piso uno tras otro
 * (que además desbordaba el título del PDF). Si no comparten madre, cae de
 * vuelta a la lista unida con " + " como respaldo. El campo queda editable
 * igual en la pantalla de revisión, esto es solo el valor inicial.
 */
async function pickCombinedName(folders) {
  const parentIds = new Set(folders.map((f) => f.parentId));
  if (parentIds.size === 1) {
    const parent = await getFolder([...parentIds][0]);
    if (parent?.name) return parent.name;
  }
  return folders.map((f) => f.name).join(' + ');
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

function aiMultiResultSheet(results, skippedNames) {
  const okCount = results.filter((r) => r.ok).length;
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const rowsHTML = results
      .map((r) => {
        if (r.ok) {
          const most = r.ranking[0];
          const least = r.ranking[r.ranking.length - 1];
          return `
            <div class="ai-avance-multi-row">
              <h3>${escapeHTML(r.folder.name)}</h3>
              <p class="modal-message"><strong>Más avanzada:</strong> ${escapeHTML(most)} · <strong>Menos avanzada:</strong> ${escapeHTML(least)}</p>
              ${r.reasoning ? `<p class="ai-avance-reasoning">${escapeHTML(r.reasoning)}</p>` : ''}
              ${r.substitutions.length ? `<ul class="ai-avance-substitutions">${r.substitutions.map((s) => `<li>${escapeHTML(s)}</li>`).join('')}</ul>` : ''}
            </div>
          `;
        }
        return `
          <div class="ai-avance-multi-row ai-avance-multi-error">
            <h3>${escapeHTML(r.folder.name)}</h3>
            <p class="modal-message">⚠️ No se incluye: ${escapeHTML(r.error)}</p>
          </div>
        `;
      })
      .join('');
    const skippedHTML = skippedNames.length
      ? `<p class="modal-message">⚠️ No se revisaron (no tienen forma de Calle/Piso): ${skippedNames.map(escapeHTML).join(', ')}</p>`
      : '';

    overlay.innerHTML = `
      <div class="modal ai-avance-result ai-avance-multi" role="dialog" aria-modal="true">
        <h2>Resultado de la IA (${okCount} de ${results.length})</h2>
        <div class="ai-avance-multi-list">${rowsHTML}</div>
        ${skippedHTML}
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
 * Hace todo el trabajo de comparar UNA carpeta "Calle X"/"Piso Y" con IA y
 * armar sus 8 fotos — sin tocar la interfaz (nada de overlays ni
 * diálogos), para poder reusarlo tanto para una sola carpeta
 * (openAiAvanceFlow) como para varias combinadas (openAiAvanceMultiFlow).
 * Nunca lanza: siempre devuelve { ok, folder, ... }.
 */
async function compareGroup(folder, token) {
  const children = await getChildFolders(folder.id);
  const fotosFolder = children.find((f) => /^fotos\s/i.test(f.name.trim()));
  const unitFolders = children.filter((f) => /^\d+$/.test(f.name.trim()));

  const unitsWithCounts = await Promise.all(
    unitFolders.map(async (f) => ({ folder: f, count: await getPhotoCountByFolder(f.id) }))
  );
  const photographedUnits = unitsWithCounts.filter((u) => u.count > 0);

  if (photographedUnits.length < 2) {
    return { ok: false, folder, error: 'Necesita fotos de al menos 2 casas/deptos.' };
  }

  const generalPhotos = fotosFolder ? await getPhotosByFolder(fotosFolder.id) : [];
  if (generalPhotos.length < 2) {
    return { ok: false, folder, error: `"${fotosFolder ? fotosFolder.name : 'Fotos'}" necesita al menos 2 fotos generales.` };
  }

  let result;
  try {
    const unitsPayload = await Promise.all(
      photographedUnits.map(async ({ folder: uf }) => {
        const photos = (await getPhotosByFolder(uf.id)).slice(0, MAX_PHOTOS_PER_UNIT);
        const encoded = await Promise.all(photos.map((p) => prepareImageForAI(p.blob)));
        return { unitFolderName: uf.name.trim(), photos: encoded };
      })
    );
    result = await callAiAvanceBackend(folder.name, unitsPayload, token);
  } catch (err) {
    console.error(`Error comparando fotos con IA (${folder.name}):`, err);
    return {
      ok: false,
      folder,
      error: err.offline ? 'Necesitás internet para usar esta función.' : (err.message || 'No se pudo comparar las fotos con la IA.'),
    };
  }

  const { ranking, reasoning } = result || {};
  if (!ranking || ranking.length < 2) {
    return { ok: false, folder, error: 'La IA no pudo determinar un resultado.' };
  }

  const photosByUnit = new Map();
  for (const { folder: uf } of photographedUnits) {
    photosByUnit.set(uf.name.trim(), await getPhotosByFolder(uf.id));
  }

  const { finalPhotos, substitutions } = buildFinalPhotoArray({ groupName: folder.name, generalPhotos, ranking, photosByUnit });

  return { ok: true, folder, ranking, reasoning, substitutions, finalPhotos };
}

/**
 * Punto de entrada del botón "🤖 Armar informe con IA" en una carpeta
 * "Calle X"/"Piso Y". Compara las unidades numeradas con IA, arma las 8
 * fotos del informe y abre la misma pantalla de revisión que ya usa el
 * resto de la app.
 */
export async function openAiAvanceFlow(folder) {
  let token;
  try {
    token = await signIn();
  } catch (err) {
    console.error(err);
    toast('No se pudo conectar con Google.');
    return;
  }

  const loadingOverlay = showLoadingOverlay('Comparando fotos con IA…');
  const result = await compareGroup(folder, token);
  loadingOverlay.remove();

  if (!result.ok) {
    toast(result.error);
    return;
  }

  const proceed = await aiResultSheet({ groupName: folder.name, ranking: result.ranking, reasoning: result.reasoning, substitutions: result.substitutions });
  if (!proceed) return;

  localStorage.setItem(LAST_FORMAT_KEY, /^piso\s/i.test(folder.name.trim()) ? 'depto-avance' : 'casas-avance');

  await openExportReviewScreen(result.finalPhotos, { name: folder.name, reportNumber: '', reportPeriod: '' });
}

/**
 * Igual que openAiAvanceFlow, pero para varias carpetas "Calle X"/"Piso Y"
 * seleccionadas a la vez (selección múltiple ya existente en
 * foldersView.js) — arma un solo informe combinado con el bloque de 8
 * fotos de cada una, comparándolas una por una y mostrando un resumen
 * conjunto antes de armar el PDF. Las carpetas que no tengan la forma
 * correcta, o cuya comparación falle, se dejan afuera avisando por qué —
 * el resto del informe se arma igual con las que sí funcionaron.
 */
export async function openAiAvanceMultiFlow(folders) {
  const checks = await Promise.all(folders.map(async (f) => [f, await isAiAvanceGroup(f)]));
  const validFolders = checks.filter(([, ok]) => ok).map(([f]) => f);
  const skippedNames = checks.filter(([, ok]) => !ok).map(([f]) => f.name);

  if (!validFolders.length) {
    toast('Ninguna de las carpetas seleccionadas tiene la forma "Calle X"/"Piso Y" necesaria.');
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

  const loadingOverlay = showLoadingOverlay(`Comparando ${validFolders[0].name} (1 de ${validFolders.length})…`);
  const results = [];
  for (let i = 0; i < validFolders.length; i++) {
    updateLoadingMessage(loadingOverlay, `Comparando ${validFolders[i].name} (${i + 1} de ${validFolders.length})…`);
    results.push(await compareGroup(validFolders[i], token));
  }
  loadingOverlay.remove();

  const succeeded = results.filter((r) => r.ok);
  if (!succeeded.length) {
    toast('No se pudo comparar ninguna de las carpetas seleccionadas.');
    return;
  }

  const proceed = await aiMultiResultSheet(results, skippedNames);
  if (!proceed) return;

  localStorage.setItem(LAST_FORMAT_KEY, /^piso\s/i.test(succeeded[0].folder.name.trim()) ? 'depto-avance' : 'casas-avance');

  const finalPhotos = succeeded.flatMap((r) => r.finalPhotos);
  const combinedName = await pickCombinedName(succeeded.map((r) => r.folder));

  await openExportReviewScreen(finalPhotos, { name: combinedName, reportNumber: '', reportPeriod: '' });
}

// ---------- "Mismo avance" combinado (sin IA — no hay nada que comparar) ----------
//
// Para torres/calles donde todas las unidades de un piso van con el mismo
// avance (no hace falta elegir más/menos avanzada), el trabajo tedioso es
// puramente de armado: 2 fotos generales tituladas "Piso X" + 6 fotos de
// deptos al azar, por cada piso, en orden — nada que la IA necesite
// decidir. Por eso esto no llama al backend ni pide sesión de Google: solo
// junta fotos que ya están descargadas localmente.

/**
 * ¿Esta carpeta sirve como grupo "mismo avance"? Necesita una subcarpeta
 * "Fotos ..." (fotos generales) y al menos otra subcarpeta con fotos —
 * a diferencia de isAiAvanceGroup, no exige que esa otra carpeta tenga
 * nombre numérico: puede ser una sola carpeta "Deptos Piso X" con todo
 * junto, varias numeradas, o cualquier combinación.
 */
export async function isSameAdvanceGroup(folder) {
  if (!folder || !folder.id) return false;
  const children = await getChildFolders(folder.id);
  const fotosFolder = children.find((f) => /^fotos\s/i.test(f.name.trim()));
  if (!fotosFolder) return false;
  const otherFolders = children.filter((f) => f.id !== fotosFolder.id);
  const counts = await Promise.all(otherFolders.map((f) => getPhotoCountByFolder(f.id)));
  return counts.some((c) => c > 0);
}

/**
 * Arma el bloque de 8 fotos (2 generales + hasta 6 de depto, todas al
 * azar) de UN piso/calle "mismo avance". Si hay varias carpetas de fotos
 * de depto (ej. un piso repartido en 2 carpetas), se juntan todas antes de
 * elegir — así no importa cómo esté organizado el piso, mientras tenga
 * fotos en alguna subcarpeta que no sea la de "Fotos ...".
 */
async function buildSameAdvanceBlock(folder) {
  const children = await getChildFolders(folder.id);
  const fotosFolder = children.find((f) => /^fotos\s/i.test(f.name.trim()));
  const otherFolders = children.filter((f) => f.id !== fotosFolder?.id);

  const generalPhotos = fotosFolder ? await getPhotosByFolder(fotosFolder.id) : [];
  if (generalPhotos.length < 2) {
    return { ok: false, folder, error: `"${fotosFolder ? fotosFolder.name : 'Fotos'}" necesita al menos 2 fotos generales.` };
  }

  const depotoPhotoArrays = await Promise.all(otherFolders.map((f) => getPhotosByFolder(f.id)));
  const depotoPhotos = depotoPhotoArrays.flat();
  if (!depotoPhotos.length) {
    return { ok: false, folder, error: 'No hay fotos de departamentos en esta carpeta todavía.' };
  }

  const generalPick = pickRandom(generalPhotos, 2).map((p) => ({ ...p, title: folder.name }));
  const depotoPick = pickRandom(depotoPhotos, Math.min(6, depotoPhotos.length));

  return { ok: true, folder, finalPhotos: [...generalPick, ...depotoPick], depotoCount: depotoPick.length };
}

function sameAdvanceResultSheet(results) {
  const okCount = results.filter((r) => r.ok).length;
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const rowsHTML = results
      .map((r) => {
        if (r.ok) {
          const short = r.depotoCount < 6
            ? ` <span class="ai-avance-multi-warn">(solo ${r.depotoCount} de depto — menos de 6)</span>`
            : '';
          return `
            <div class="ai-avance-multi-row">
              <h3>${escapeHTML(r.folder.name)}</h3>
              <p class="modal-message">✅ ${r.finalPhotos.length} fotos: 2 generales + ${r.depotoCount} de depto${short}</p>
            </div>
          `;
        }
        return `
          <div class="ai-avance-multi-row ai-avance-multi-error">
            <h3>${escapeHTML(r.folder.name)}</h3>
            <p class="modal-message">⚠️ No se incluye: ${escapeHTML(r.error)}</p>
          </div>
        `;
      })
      .join('');

    overlay.innerHTML = `
      <div class="modal ai-avance-result ai-avance-multi" role="dialog" aria-modal="true">
        <h2>Mismo avance combinado (${okCount} de ${results.length})</h2>
        <div class="ai-avance-multi-list">${rowsHTML}</div>
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
 * Punto de entrada del botón "🏢 Mismo avance combinado": arma un informe
 * con varios pisos/calles donde todas las unidades van con el mismo
 * avance — 2 fotos generales tituladas + 6 de depto al azar por cada uno,
 * concatenados en el orden en que se seleccionaron. No llama a ninguna
 * IA ni necesita sesión de Google — solo trabaja con fotos ya guardadas
 * localmente, así que es instantáneo y sin costo.
 */
export async function openSameAdvanceMultiFlow(folders) {
  const results = await Promise.all(folders.map((f) => buildSameAdvanceBlock(f)));
  const succeeded = results.filter((r) => r.ok);

  if (!succeeded.length) {
    toast('Ninguna de las carpetas seleccionadas tiene fotos de departamentos todavía.');
    return;
  }

  const proceed = await sameAdvanceResultSheet(results);
  if (!proceed) return;

  localStorage.setItem(LAST_FORMAT_KEY, /^piso\s/i.test(succeeded[0].folder.name.trim()) ? 'depto-iguales' : 'casas-iguales');

  const finalPhotos = succeeded.flatMap((r) => r.finalPhotos);
  const combinedName = await pickCombinedName(succeeded.map((r) => r.folder));

  await openExportReviewScreen(finalPhotos, { name: combinedName, reportNumber: '', reportPeriod: '' });
}
