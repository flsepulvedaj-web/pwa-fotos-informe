import { addPhoto, deletePhoto, getFolder } from '../db.js';
import { navigate } from '../router.js';
import { canvasToBlob, toast } from '../utils.js';
import { trySync } from '../sync.js';

let activeStream = null;
let facingMode = 'environment';

// Lista de lentes traseros del teléfono (ej. principal + ultra angular),
// detectada una sola vez por sesión de la app (abrir/cerrar cámaras repetidas
// veces para probarlas causa parpadeo, así que se guarda en caché). No todos
// los teléfonos informan el lente angular como "zoom" del lente principal
// (de hecho varios Samsung no lo hacen), así que en vez de adivinarlo se deja
// que el usuario los recorra a mano con el botón "Lente" y se recuerda cuál
// eligió la última vez.
const LENS_STORAGE_KEY = 'camera-lens-device-id';
let backCameraDevices = null;

async function probeBackCameras() {
  if (backCameraDevices) return backCameraDevices;
  if (!navigator.mediaDevices?.enumerateDevices) return (backCameraDevices = []);

  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return (backCameraDevices = []);
  }
  const videoInputs = devices.filter((d) => d.kind === 'videoinput');
  if (videoInputs.length <= 1) return (backCameraDevices = videoInputs);

  const candidates = [];
  for (const d of videoInputs) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: d.deviceId } }, audio: false });
      const settings = s.getVideoTracks()[0]?.getSettings?.() ?? {};
      s.getTracks().forEach((t) => t.stop());
      if (!settings.facingMode || settings.facingMode === 'environment') candidates.push(d);
    } catch {
      // este lente no se pudo abrir para probarlo, se descarta
    }
  }
  return (backCameraDevices = candidates.length ? candidates : videoInputs);
}

function stopStream() {
  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }
}

// Por defecto la app queda fija en vertical (ver manifest.webmanifest), pero
// en la cámara hay que poder tomar fotos horizontales (0.6x), así que se
// libera la orientación al entrar y se vuelve a fijar en vertical al salir.
// screen.orientation.lock()/unlock() solo funciona con la app instalada
// (display standalone); en un navegador de escritorio simplemente no hace nada.
function unlockOrientation() {
  try {
    screen.orientation?.unlock?.();
  } catch {
    // no soportado, no pasa nada
  }
}

async function relockPortrait() {
  try {
    await screen.orientation?.lock?.('portrait-primary');
  } catch {
    // no soportado, no pasa nada
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export async function renderCameraView(container, folderId) {
  stopStream();

  const folder = await getFolder(folderId);
  const linkedToDrive = !!folder?.driveFolderId;

  // Fotos tomadas en esta sesión de cámara: { id, url }, en orden de captura.
  const sessionPhotos = [];
  let currentZoom = null;

  unlockOrientation();

  container.innerHTML = `
    <div class="camera-view">
      <div class="camera-stage">
        <video id="camera-video" autoplay playsinline muted></video>
        <canvas id="camera-canvas" hidden></canvas>
      </div>
      <div class="camera-error" id="camera-error" hidden></div>

      <div class="camera-topbar">
        <button class="icon-btn camera-close" id="btn-close">✕</button>
        <button class="btn btn-secondary camera-lens" id="btn-lens" hidden></button>
        <button class="btn btn-primary camera-done" id="btn-done">Listo</button>
      </div>

      <div class="camera-zoom" id="camera-zoom" hidden></div>

      <button class="camera-last-shot" id="last-shot" hidden>
        <img id="last-shot-img" alt="Última foto" />
        <span class="camera-shot-count" id="shot-count">0</span>
      </button>

      <div class="camera-controls" id="controls-live">
        <span class="camera-spacer"></span>
        <button class="shutter-btn" id="btn-shutter" title="Tomar foto"></button>
        <button class="icon-btn camera-flip" id="btn-flip" title="Cambiar cámara">🔄</button>
      </div>
    </div>
  `;

  const onHashChange = () => {
    sessionPhotos.forEach((p) => URL.revokeObjectURL(p.url));
    stopStream();
    relockPortrait();
    window.removeEventListener('hashchange', onHashChange);
  };
  window.addEventListener('hashchange', onHashChange);

  const video = container.querySelector('#camera-video');
  const canvas = container.querySelector('#camera-canvas');
  const errorEl = container.querySelector('#camera-error');
  const lastShotBtn = container.querySelector('#last-shot');
  const lastShotImg = container.querySelector('#last-shot-img');
  const shotCount = container.querySelector('#shot-count');
  const zoomEl = container.querySelector('#camera-zoom');
  const lensBtn = container.querySelector('#btn-lens');

  function goBack() {
    sessionPhotos.forEach((p) => URL.revokeObjectURL(p.url));
    stopStream();
    relockPortrait();
    navigate(folderId ? `/fotos/folder/${folderId}` : '/fotos');
  }

  container.querySelector('#btn-close').addEventListener('click', goBack);
  container.querySelector('#btn-done').addEventListener('click', goBack);

  function formatZoom(z) {
    return (Number.isInteger(z) ? z : z.toFixed(1)) + 'x';
  }

  function updateZoomUI() {
    zoomEl.querySelectorAll('.camera-zoom-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.zoom) === currentZoom);
    });
  }

  async function applyZoom(value) {
    const track = activeStream?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: value }] });
      currentZoom = value;
      updateZoomUI();
    } catch (err) {
      console.warn('No se pudo aplicar el zoom', value, err);
    }
  }

  // Además del zoom digital normal (1x en adelante), muchos teléfonos exponen
  // el lente ultra gran angular como un valor de "zoom" bajo 1 (ej. 0.6x).
  // Si el navegador informa ese rango se arma la fila de botones y se parte
  // en 0.6x por defecto, que es lo que exige el formato del informe.
  async function initZoom() {
    zoomEl.innerHTML = '';
    zoomEl.hidden = true;
    currentZoom = null;

    const track = activeStream?.getVideoTracks()[0];
    const caps = track?.getCapabilities ? track.getCapabilities() : null;
    if (!caps?.zoom) return;

    const { min, max } = caps.zoom;
    const defaultZoom = clamp(0.6, min, max);
    const presets = [min, defaultZoom, 1, 2, 3].filter((v) => v >= min && v <= max);
    const uniquePresets = [...new Set(presets)].sort((a, b) => a - b);
    if (!uniquePresets.length) return;

    zoomEl.innerHTML = uniquePresets
      .map((z) => `<button type="button" class="camera-zoom-btn" data-zoom="${z}">${formatZoom(z)}</button>`)
      .join('');
    zoomEl.hidden = false;

    await applyZoom(defaultZoom);
  }

  zoomEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.camera-zoom-btn');
    if (!btn) return;
    applyZoom(Number(btn.dataset.zoom));
  });

  function updateLensButtonUI() {
    if (facingMode !== 'environment' || !backCameraDevices || backCameraDevices.length <= 1) {
      lensBtn.hidden = true;
      return;
    }
    const currentId = activeStream?.getVideoTracks()[0]?.getSettings?.().deviceId;
    const idx = Math.max(0, backCameraDevices.findIndex((d) => d.deviceId === currentId));
    lensBtn.hidden = false;
    lensBtn.textContent = `Lente ${idx + 1}/${backCameraDevices.length}`;
  }

  lensBtn.addEventListener('click', async () => {
    if (!backCameraDevices || backCameraDevices.length <= 1) return;
    const currentId = activeStream?.getVideoTracks()[0]?.getSettings?.().deviceId;
    const idx = Math.max(0, backCameraDevices.findIndex((d) => d.deviceId === currentId));
    const next = backCameraDevices[(idx + 1) % backCameraDevices.length];
    localStorage.setItem(LENS_STORAGE_KEY, next.deviceId);
    stopStream();
    await startCamera();
    toast(`Cambiado a ${lensBtn.textContent} — se recuerda para la próxima vez.`);
  });

  async function startCamera() {
    try {
      // La primera vez que se abre la cámara trasera en esta sesión hay que
      // detectar qué otros lentes tiene el teléfono. La mayoría de los
      // teléfonos no permiten tener dos cámaras abiertas a la vez, así que
      // ese sondeo se hace con la cámara principal cerrada (un parpadeo
      // único la primera vez, no en cada foto).
      if (facingMode === 'environment' && backCameraDevices === null) {
        const probeStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        probeStream.getTracks().forEach((t) => t.stop());
        await probeBackCameras();
      }

      // Si ya se sabe qué lente eligió el usuario con el botón "Lente", abrir
      // ese directamente. Si no, dejar que el teléfono elija el principal
      // como siempre, e intentar además que parta en 0.6x (funciona en
      // algunos teléfonos, no en todos).
      const savedLensId = facingMode === 'environment' ? localStorage.getItem(LENS_STORAGE_KEY) : null;
      const savedLensStillValid = savedLensId && backCameraDevices?.some((d) => d.deviceId === savedLensId);
      const videoConstraints = savedLensStillValid
        ? { deviceId: { exact: savedLensId } }
        : { facingMode: { ideal: facingMode } };
      if (!savedLensStillValid && facingMode === 'environment') videoConstraints.zoom = { ideal: 0.6 };

      try {
        activeStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      } catch (err) {
        // El lente guardado ya no existe, o el teléfono rechaza la constraint
        // de zoom de plano (OverconstrainedError): reintentar con lo mínimo.
        activeStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingMode } },
          audio: false,
        });
      }
      video.srcObject = activeStream;
      errorEl.hidden = true;
      await initZoom();
      updateLensButtonUI();
    } catch (err) {
      console.error('Error accediendo a la cámara:', err);
      errorEl.hidden = false;
      errorEl.innerHTML = `
        <p>No se pudo acceder a la cámara.</p>
        <p>Revisa que hayas dado permiso de cámara a la app.</p>
        <button class="btn btn-secondary" id="btn-back-error">Volver</button>
      `;
      errorEl.querySelector('#btn-back-error').addEventListener('click', goBack);
    }
  }

  function updateLastShotUI() {
    if (!sessionPhotos.length) {
      lastShotBtn.hidden = true;
      return;
    }
    const last = sessionPhotos[sessionPhotos.length - 1];
    lastShotImg.src = last.url;
    shotCount.textContent = String(sessionPhotos.length);
    lastShotBtn.hidden = false;
  }

  container.querySelector('#btn-shutter').addEventListener('click', async () => {
    if (!video.videoWidth) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
    const photo = await addPhoto({
      folderId,
      blob,
      title: '',
      note: '',
      syncStatus: linkedToDrive ? 'pending' : null,
    });
    sessionPhotos.push({ id: photo.id, url: URL.createObjectURL(blob) });
    updateLastShotUI();
    if (linkedToDrive) trySync();
  });

  lastShotBtn.addEventListener('click', () => {
    if (!sessionPhotos.length) return;
    const last = sessionPhotos[sessionPhotos.length - 1];
    openLastShotPreview(last, async () => {
      await deletePhoto(last.id);
      URL.revokeObjectURL(last.url);
      sessionPhotos.pop();
      updateLastShotUI();
      toast('Foto eliminada.');
    });
  });

  container.querySelector('#btn-flip').addEventListener('click', async () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    stopStream();
    await startCamera();
  });

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    errorEl.hidden = false;
    errorEl.innerHTML = `
      <p>Este navegador no soporta acceso a la cámara.</p>
      <button class="btn btn-secondary" id="btn-back-error">Volver</button>
    `;
    errorEl.querySelector('#btn-back-error').addEventListener('click', goBack);
    return;
  }

  await startCamera();
}

function openLastShotPreview(photo, onDelete) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay last-shot-overlay';
  overlay.innerHTML = `
    <div class="modal last-shot-preview" role="dialog" aria-modal="true">
      <img src="${photo.url}" alt="Última foto" />
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-action="close">Cerrar</button>
        <button type="button" class="btn btn-danger" data-action="delete">Eliminar esta foto</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  function cleanup() {
    overlay.remove();
  }
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'close') cleanup();
    if (btn.dataset.action === 'delete') {
      cleanup();
      onDelete();
    }
  });
}
