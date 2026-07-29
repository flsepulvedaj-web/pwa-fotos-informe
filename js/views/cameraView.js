import { addPhoto, deletePhoto } from '../db.js';
import { navigate } from '../router.js';
import { canvasToBlob, toast } from '../utils.js';

let activeStream = null;
let facingMode = 'environment';

function stopStream() {
  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }
}

export async function renderCameraView(container, folderId) {
  stopStream();

  // Fotos tomadas en esta sesión de cámara: { id, url }, en orden de captura.
  const sessionPhotos = [];

  container.innerHTML = `
    <div class="camera-view">
      <div class="camera-stage">
        <video id="camera-video" autoplay playsinline muted></video>
        <canvas id="camera-canvas" hidden></canvas>
      </div>
      <div class="camera-error" id="camera-error" hidden></div>

      <div class="camera-topbar">
        <button class="icon-btn camera-close" id="btn-close">✕</button>
        <button class="btn btn-primary camera-done" id="btn-done">Listo</button>
      </div>

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
    window.removeEventListener('hashchange', onHashChange);
  };
  window.addEventListener('hashchange', onHashChange);

  const video = container.querySelector('#camera-video');
  const canvas = container.querySelector('#camera-canvas');
  const errorEl = container.querySelector('#camera-error');
  const lastShotBtn = container.querySelector('#last-shot');
  const lastShotImg = container.querySelector('#last-shot-img');
  const shotCount = container.querySelector('#shot-count');

  function goBack() {
    sessionPhotos.forEach((p) => URL.revokeObjectURL(p.url));
    stopStream();
    navigate(folderId ? `/folder/${folderId}` : '/');
  }

  container.querySelector('#btn-close').addEventListener('click', goBack);
  container.querySelector('#btn-done').addEventListener('click', goBack);

  async function startCamera() {
    try {
      activeStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facingMode } },
        audio: false,
      });
      video.srcObject = activeStream;
      errorEl.hidden = true;
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
    const photo = await addPhoto({ folderId, blob, title: '', note: '' });
    sessionPhotos.push({ id: photo.id, url: URL.createObjectURL(blob) });
    updateLastShotUI();
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
