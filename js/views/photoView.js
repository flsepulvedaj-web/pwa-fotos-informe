import { ROOT_ID, getPhoto, updatePhoto, deletePhoto, getPhotosByFolder, getPhotoGroupsRecursive } from '../db.js';
import { navigate, getQueryParams } from '../router.js';
import { allPhotosFocusKey } from './allPhotosView.js';
import { promptDialog, confirmDialog, toast, escapeHTML, formatDate as fmtDate } from '../utils.js';
import { rotatePhoto } from '../sync.js';

let currentURL = null;
let keyHandler = null;

const MAX_SCALE = 6;
const DOUBLE_TAP_MS = 300;

export async function renderPhotoView(container, photoId) {
  if (currentURL) {
    URL.revokeObjectURL(currentURL);
    currentURL = null;
  }
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }

  const photo = await getPhoto(photoId);
  if (!photo) {
    navigate('/fotos');
    return;
  }

  // Abierta desde "Todas las fotos" (?all=<carpeta de partida>): las flechas
  // recorren todas las fotos de esa pantalla, no solo las de la carpeta de la
  // foto, y "atrás" vuelve a esa pantalla.
  const allParam = getQueryParams().get('all');
  let backPath = photo.folderId ? `/fotos/folder/${photo.folderId}` : '/fotos';
  let siblings = photo.folderId ? await getPhotosByFolder(photo.folderId) : [photo];
  if (allParam !== null) {
    const groups = await getPhotoGroupsRecursive(allParam === 'root' ? ROOT_ID : allParam);
    const flat = groups.flatMap((g) => g.photos);
    if (flat.some((p) => p.id === photoId)) {
      siblings = flat;
      backPath = `/fotos/todas/${allParam}`;
      try {
        sessionStorage.setItem(allPhotosFocusKey(allParam), photoId);
      } catch {
        // sin sessionStorage: al volver queda arriba de todo
      }
    }
  }
  const index = siblings.findIndex((p) => p.id === photoId);
  const prev = siblings[index - 1];
  const next = siblings[index + 1];
  currentURL = URL.createObjectURL(photo.blob);

  container.innerHTML = `
    <div class="photo-view">
      <header class="app-header">
        <button class="icon-btn" id="btn-back">←</button>
        <span class="header-title">${escapeHTML(photo.title || 'Foto')}</span>
        <div class="header-actions">
          <button class="icon-btn" id="btn-rotate-left" title="Rotar a la izquierda">↺</button>
          <button class="icon-btn" id="btn-rotate-right" title="Rotar a la derecha">↻</button>
          <button class="icon-btn" id="btn-edit" title="Editar">✏️</button>
          <button class="icon-btn" id="btn-delete" title="Eliminar">🗑️</button>
        </div>
      </header>
      <main class="photo-view-content">
        <div class="photo-stage" id="photo-stage">
          <img src="${currentURL}" alt="${escapeHTML(photo.title || 'Foto')}" draggable="false" />
          ${prev ? '<button type="button" class="photo-nav photo-nav-prev" data-dir="-1" title="Foto anterior">‹</button>' : ''}
          ${next ? '<button type="button" class="photo-nav photo-nav-next" data-dir="1" title="Foto siguiente">›</button>' : ''}
          ${siblings.length > 1 ? `<span class="photo-counter">${index + 1} / ${siblings.length}</span>` : ''}
        </div>
        <div class="photo-meta">
          <p class="photo-date">${fmtDate(photo.createdAt)}</p>
          ${photo.note ? `<p class="photo-note">${escapeHTML(photo.note)}</p>` : ''}
        </div>
      </main>
    </div>
  `;

  const stage = container.querySelector('#photo-stage');
  const img = stage.querySelector('img');

  // replaceState en vez de navigate(): pasar de foto en foto no debe llenar
  // el historial — "atrás" vuelve directo a la carpeta.
  function goTo(dir) {
    const target = dir < 0 ? prev : next;
    if (!target) return;
    history.replaceState(null, '', `#/fotos/photo/${target.id}${allParam !== null ? `?all=${allParam}` : ''}`);
    renderPhotoView(container, target.id);
  }

  stage.querySelectorAll('.photo-nav').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      goTo(Number(btn.dataset.dir));
    })
  );

  keyHandler = (e) => {
    if (!document.body.contains(stage)) {
      document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
      return;
    }
    if (e.target.closest('input, textarea, .modal-overlay')) return;
    if (e.key === 'ArrowLeft') goTo(-1);
    if (e.key === 'ArrowRight') goTo(1);
  };
  document.addEventListener('keydown', keyHandler);

  // ---------- Zoom (rueda del mouse, pellizco, doble toque) y arrastre ----------
  let scale = 1;
  let tx = 0;
  let ty = 0;

  function apply() {
    img.style.transform = scale === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
    stage.classList.toggle('zoomed', scale > 1);
  }

  function clampPan() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    tx = Math.min(0, Math.max(w - w * scale, tx));
    ty = Math.min(0, Math.max(h - h * scale, ty));
  }

  function zoomAt(px, py, newScale) {
    newScale = Math.min(MAX_SCALE, Math.max(1, newScale));
    tx = px - (px - tx) * (newScale / scale);
    ty = py - (py - ty) * (newScale / scale);
    scale = newScale;
    if (scale === 1) {
      tx = 0;
      ty = 0;
    }
    clampPan();
    apply();
  }

  function resetZoom() {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  }

  function localPoint(clientX, clientY) {
    const rect = stage.getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  }

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const [px, py] = localPoint(e.clientX, e.clientY);
      zoomAt(px, py, scale * Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false }
  );

  const pointers = new Map();
  let gesture = null;
  let lastTap = null;

  function startSingle(p) {
    gesture = { type: scale > 1 ? 'pan' : 'swipe', sx: p.x, sy: p.y, tx, ty, moved: false };
  }

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.photo-nav')) return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), scale };
    } else if (pointers.size === 1) {
      startSingle({ x: e.clientX, y: e.clientY });
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture.type === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const [px, py] = localPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
      if (gesture.dist > 0) zoomAt(px, py, gesture.scale * (dist / gesture.dist));
      return;
    }
    const dx = e.clientX - gesture.sx;
    const dy = e.clientY - gesture.sy;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) gesture.moved = true;
    if (gesture.type === 'pan') {
      tx = gesture.tx + dx;
      ty = gesture.ty + dy;
      clampPan();
      apply();
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    const single = pointers.size === 1 && gesture && gesture.type !== 'pinch';
    if (single) {
      const dx = e.clientX - gesture.sx;
      const dy = e.clientY - gesture.sy;
      if (gesture.type === 'swipe' && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        pointers.delete(e.pointerId);
        gesture = null;
        goTo(dx < 0 ? 1 : -1);
        return;
      }
      if (!gesture.moved && e.type === 'pointerup') {
        const now = Date.now();
        if (lastTap && now - lastTap.time < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
          const [px, py] = localPoint(e.clientX, e.clientY);
          if (scale > 1) resetZoom();
          else zoomAt(px, py, 2.5);
          lastTap = null;
        } else {
          lastTap = { time: now, x: e.clientX, y: e.clientY };
        }
      }
    }
    pointers.delete(e.pointerId);
    if (pointers.size === 1) {
      const [p] = pointers.values();
      startSingle(p);
      gesture.moved = true;
    } else if (pointers.size === 0) {
      gesture = null;
    }
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  // ---------- Acciones ----------
  container.querySelector('#btn-back').addEventListener('click', () => navigate(backPath));

  async function rotate(direction) {
    try {
      const blob = await rotatePhoto(photoId, direction);
      if (!blob || !document.body.contains(img)) return;
      if (currentURL) URL.revokeObjectURL(currentURL);
      currentURL = URL.createObjectURL(blob);
      img.src = currentURL;
      resetZoom();
    } catch (err) {
      console.error('No se pudo rotar la foto:', err);
      toast('No se pudo rotar la foto.');
    }
  }
  container.querySelector('#btn-rotate-left').addEventListener('click', () => rotate('left'));
  container.querySelector('#btn-rotate-right').addEventListener('click', () => rotate('right'));

  container.querySelector('#btn-edit').addEventListener('click', async () => {
    const result = await promptDialog({
      title: 'Editar foto',
      fields: [
        { name: 'title', label: 'Título', value: photo.title },
        { name: 'note', label: 'Nota', value: photo.note, type: 'textarea' },
      ],
      confirmLabel: 'Guardar',
    });
    if (result) {
      await updatePhoto(photoId, { title: result.title, note: result.note });
      renderPhotoView(container, photoId);
    }
  });

  container.querySelector('#btn-delete').addEventListener('click', async () => {
    const ok = await confirmDialog('¿Eliminar esta foto? Esta acción no se puede deshacer.');
    if (ok) {
      await deletePhoto(photoId);
      toast('Foto eliminada.');
      navigate(backPath);
    }
  });
}
