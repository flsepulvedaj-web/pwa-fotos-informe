import { addPhoto } from '../db.js';
import { navigate } from '../router.js';
import { canvasToBlob, promptDialog, toast } from '../utils.js';

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

  container.innerHTML = `
    <div class="camera-view">
      <div class="camera-stage">
        <video id="camera-video" autoplay playsinline muted></video>
        <canvas id="camera-canvas" hidden></canvas>
        <img id="camera-preview" hidden alt="Foto capturada" />
      </div>
      <div class="camera-error" id="camera-error" hidden></div>
      <div class="camera-controls" id="controls-live">
        <button class="icon-btn camera-close" id="btn-close">✕</button>
        <button class="shutter-btn" id="btn-shutter" title="Tomar foto"></button>
        <button class="icon-btn camera-flip" id="btn-flip" title="Cambiar cámara">🔄</button>
      </div>
      <div class="camera-controls" id="controls-preview" hidden>
        <button class="btn btn-secondary" id="btn-retake">Repetir</button>
        <button class="btn btn-primary" id="btn-use">Usar foto</button>
      </div>
    </div>
  `;

  const onHashChange = () => {
    stopStream();
    window.removeEventListener('hashchange', onHashChange);
  };
  window.addEventListener('hashchange', onHashChange);

  const video = container.querySelector('#camera-video');
  const canvas = container.querySelector('#camera-canvas');
  const preview = container.querySelector('#camera-preview');
  const errorEl = container.querySelector('#camera-error');
  const controlsLive = container.querySelector('#controls-live');
  const controlsPreview = container.querySelector('#controls-preview');

  container.querySelector('#btn-close').addEventListener('click', () => goBack());

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
      errorEl.querySelector('#btn-back-error').addEventListener('click', () => goBack());
    }
  }

  function goBack() {
    stopStream();
    navigate(folderId ? `/folder/${folderId}` : '/');
  }

  let capturedBlob = null;

  container.querySelector('#btn-shutter').addEventListener('click', async () => {
    if (!video.videoWidth) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    capturedBlob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
    preview.src = URL.createObjectURL(capturedBlob);
    preview.hidden = false;
    video.hidden = true;
    controlsLive.hidden = true;
    controlsPreview.hidden = false;
  });

  container.querySelector('#btn-retake').addEventListener('click', () => {
    if (preview.src) URL.revokeObjectURL(preview.src);
    preview.hidden = true;
    video.hidden = false;
    controlsLive.hidden = false;
    controlsPreview.hidden = true;
    capturedBlob = null;
  });

  container.querySelector('#btn-use').addEventListener('click', async () => {
    if (!capturedBlob) return;
    const result = await promptDialog({
      title: 'Detalles de la foto',
      fields: [
        { name: 'title', label: 'Título (opcional)', placeholder: 'Ej: Vista general' },
        { name: 'note', label: 'Nota (opcional)', placeholder: 'Descripción para el informe', type: 'textarea' },
      ],
      confirmLabel: 'Guardar',
    });
    // Si cancela el diálogo, igual guardamos la foto sin título/nota
    // para no perder la captura.
    const title = result ? result.title : '';
    const note = result ? result.note : '';
    await addPhoto({ folderId, blob: capturedBlob, title, note });
    toast('Foto guardada.');
    goBack();
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
    errorEl.querySelector('#btn-back-error').addEventListener('click', () => goBack());
    return;
  }

  await startCamera();
}
