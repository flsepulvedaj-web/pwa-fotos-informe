import { ROOT_ID, getPhotoGroupsRecursive } from '../db.js';
import { navigate } from '../router.js';
import { escapeHTML } from '../utils.js';

export const allPhotosFocusKey = (rootId) => `allPhotosFocus:${rootId}`;

let observer = null;
const liveURLs = new Map();

function teardown() {
  if (observer) observer.disconnect();
  observer = null;
  liveURLs.forEach((url) => URL.revokeObjectURL(url));
  liveURLs.clear();
}

export async function renderAllPhotosView(container, rootId) {
  teardown();
  const backPath = rootId === ROOT_ID ? '/fotos' : `/fotos/folder/${rootId}`;

  container.innerHTML = `
    <header class="app-header">
      <button class="icon-btn" id="btn-back" title="Volver">←</button>
      <span class="header-title" id="all-title">Todas las fotos</span>
    </header>
    <main class="view-content">
      <div class="empty-state"><p>Cargando fotos…</p></div>
    </main>
  `;
  container.querySelector('#btn-back').addEventListener('click', () => navigate(backPath));

  const groups = await getPhotoGroupsRecursive(rootId);
  if (!container.querySelector('#all-title')) return;

  const total = groups.reduce((n, g) => n + g.photos.length, 0);
  container.querySelector('#all-title').textContent = `Todas las fotos · ${total}`;
  const main = container.querySelector('main');

  if (!total) {
    main.innerHTML = '<div class="empty-state"><p>No hay fotos en esta carpeta ni en sus subcarpetas.</p></div>';
    return;
  }

  const blobs = new Map();
  main.innerHTML = groups
    .map((g) => {
      g.photos.forEach((p) => blobs.set(p.id, p.blob));
      return `
        <section class="all-photos-group">
          <button type="button" class="all-photos-heading" data-folder-id="${g.folder.id}" title="Abrir esta carpeta">
            <span>${escapeHTML(g.label)}</span>
            <span class="all-photos-count">${g.photos.length}</span>
          </button>
          <div class="photo-grid">
            ${g.photos
              .map((p) => `<button type="button" class="photo-tile" data-photo-id="${p.id}"><img alt="" draggable="false" /></button>`)
              .join('')}
          </div>
        </section>`;
    })
    .join('');

  main.addEventListener('click', (e) => {
    const heading = e.target.closest('.all-photos-heading');
    if (heading) {
      navigate(`/fotos/folder/${heading.dataset.folderId}`);
      return;
    }
    const tile = e.target.closest('.photo-tile');
    if (tile) navigate(`/fotos/photo/${tile.dataset.photoId}?all=${rootId === ROOT_ID ? 'root' : rootId}`);
  });

  // Las miniaturas se crean solo cuando el tile está cerca de la pantalla, y
  // se sueltan al alejarse — con cientos de fotos, cargarlas todas juntas
  // dejaría el teléfono sin memoria.
  observer = new IntersectionObserver(
    (entries) => {
      if (!document.body.contains(main)) {
        teardown();
        return;
      }
      for (const entry of entries) {
        const tile = entry.target;
        const img = tile.firstElementChild;
        const id = tile.dataset.photoId;
        if (entry.isIntersecting) {
          if (!liveURLs.has(id) && blobs.get(id)) {
            const url = URL.createObjectURL(blobs.get(id));
            liveURLs.set(id, url);
            img.src = url;
          }
        } else if (liveURLs.has(id)) {
          img.removeAttribute('src');
          URL.revokeObjectURL(liveURLs.get(id));
          liveURLs.delete(id);
        }
      }
    },
    { rootMargin: '700px 0px' }
  );
  main.querySelectorAll('.photo-tile').forEach((tile) => observer.observe(tile));

  // Al volver desde el visor, quedar parado en la última foto que se estaba
  // viendo en vez de arrancar de nuevo arriba de todo.
  const focusKey = allPhotosFocusKey(rootId === ROOT_ID ? 'root' : rootId);
  let focusId = null;
  try {
    focusId = sessionStorage.getItem(focusKey);
    sessionStorage.removeItem(focusKey);
  } catch {
    // sin sessionStorage: se queda arriba
  }
  const focusTile = focusId && main.querySelector(`.photo-tile[data-photo-id="${CSS.escape(focusId)}"]`);
  if (focusTile) focusTile.scrollIntoView({ block: 'center' });
}
