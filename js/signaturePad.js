import { canvasToBlob } from './utils.js';

/**
 * Pantalla completa para firmar con el dedo (canvas + eventos de puntero,
 * fondo blanco). Devuelve un Blob PNG con la firma, o null si se cancela o
 * no se dibujó nada. Mismo patrón "overlay resuelto por Promise" que
 * promptDialog/confirmDialog/openExportReviewScreen.
 */
export function openSignaturePad({ title = 'Firma' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay signature-overlay';
    overlay.innerHTML = `
      <div class="modal signature-modal" role="dialog" aria-modal="true">
        <h2>${title}</h2>
        <div class="signature-canvas-wrap">
          <canvas id="signature-canvas"></canvas>
        </div>
        <p class="signature-hint">Firma con el dedo en el recuadro de arriba.</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="btn-clear">Borrar</button>
          <button type="button" class="btn btn-secondary" data-action="cancel">Cancelar</button>
          <button type="button" class="btn btn-primary" id="btn-save">Guardar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const canvas = overlay.querySelector('#signature-canvas');
    const ctx = canvas.getContext('2d');
    let hasDrawn = false;

    function clearCanvas() {
      const rect = canvas.getBoundingClientRect();
      // El tamaño real del canvas tiene que coincidir con su tamaño en
      // pantalla, si no el trazo queda desalineado del dedo.
      canvas.width = rect.width;
      canvas.height = rect.height;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#1c2b4a';
      hasDrawn = false;
    }
    clearCanvas();

    let drawing = false;
    let lastX = 0;
    let lastY = 0;

    function getPos(e) {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    canvas.addEventListener('pointerdown', (e) => {
      drawing = true;
      hasDrawn = true;
      const p = getPos(e);
      lastX = p.x;
      lastY = p.y;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = getPos(e);
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      lastX = p.x;
      lastY = p.y;
      e.preventDefault();
    });
    const stopDrawing = () => {
      drawing = false;
    };
    canvas.addEventListener('pointerup', stopDrawing);
    canvas.addEventListener('pointercancel', stopDrawing);
    canvas.addEventListener('pointerleave', stopDrawing);

    function cleanup(result) {
      overlay.remove();
      resolve(result);
    }

    overlay.querySelector('#btn-clear').addEventListener('click', clearCanvas);
    overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => cleanup(null));
    overlay.querySelector('#btn-save').addEventListener('click', async () => {
      if (!hasDrawn) {
        cleanup(null);
        return;
      }
      const blob = await canvasToBlob(canvas, 'image/png');
      cleanup(blob);
    });
  });
}
