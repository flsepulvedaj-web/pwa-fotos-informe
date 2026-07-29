import {
  ROOT_ID,
  getChildFolders,
  getFolderPath,
  createFolder,
  renameFolder,
  deleteFolderRecursive,
  getPhotosByFolder,
  getPhotosByIds,
} from '../db.js';
import { navigate } from '../router.js';
import { promptDialog, confirmDialog, toast, escapeHTML } from '../utils.js';
import { exportFolderReport } from './exportView.js';

let objectURLs = [];

function trackURL(url) {
  objectURLs.push(url);
  return url;
}

function revokeAllURLs() {
  objectURLs.forEach((u) => URL.revokeObjectURL(u));
  objectURLs = [];
}

export async function renderFoldersView(container, folderId) {
  revokeAllURLs();

  const [path, subfolders, photos] = await Promise.all([
    getFolderPath(folderId),
    getChildFolders(folderId),
    getPhotosByFolder(folderId),
  ]);

  const currentName = path.length ? path[path.length - 1].name : 'Inicio';
  const selection = new Set();
  let selectMode = false;

  container.innerHTML = `
    <header class="app-header">
      <nav class="breadcrumbs" id="breadcrumbs"></nav>
      <div class="header-actions">
        <button class="icon-btn" id="btn-select" title="Seleccionar" ${photos.length ? '' : 'disabled'}>✓</button>
      </div>
    </header>

    <main class="view-content">
      ${subfolders.length ? `
        <section class="folder-grid">
          ${subfolders.map((f) => `
            <button class="folder-tile" data-folder-id="${f.id}">
              <span class="folder-icon">📁</span>
              <span class="folder-name">${escapeHTML(f.name)}</span>
              <span class="folder-menu" data-menu-folder-id="${f.id}">⋮</span>
            </button>
          `).join('')}
        </section>
      ` : ''}

      ${photos.length ? `
        <section class="photo-grid" id="photo-grid"></section>
      ` : `
        ${subfolders.length === 0 ? `
          <div class="empty-state">
            <p>Esta carpeta está vacía.</p>
            <p>Crea una subcarpeta o toma una foto para empezar.</p>
          </div>
        ` : ''}
      `}
    </main>

    <div class="fab-row">
      <button class="fab fab-secondary" id="btn-new-folder" title="Nueva carpeta">📁➕</button>
      <button class="fab fab-primary" id="btn-camera" title="Tomar foto">📷</button>
    </div>

    <div class="selection-bar" id="selection-bar" hidden>
      <span id="selection-count">0 seleccionadas</span>
      <div class="selection-actions">
        <button class="btn btn-secondary" id="btn-cancel-select">Cancelar</button>
        <button class="btn btn-primary" id="btn-export">Exportar PDF</button>
      </div>
    </div>
  `;

  renderBreadcrumbs(path);
  if (photos.length) renderPhotoGrid(photos);

  // Navegación de subcarpetas
  container.querySelectorAll('.folder-tile').forEach((tile) => {
    tile.addEventListener('click', (e) => {
      if (e.target.classList.contains('folder-menu')) return;
      navigate(`/folder/${tile.dataset.folderId}`);
    });
  });

  container.querySelectorAll('.folder-menu').forEach((menu) => {
    menu.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = menu.dataset.menuFolderId;
      const folder = subfolders.find((f) => f.id === id);
      await openFolderMenu(folder);
    });
  });

  // Nueva carpeta
  container.querySelector('#btn-new-folder').addEventListener('click', async () => {
    const result = await promptDialog({
      title: 'Nueva carpeta',
      fields: [{ name: 'name', label: 'Nombre', placeholder: 'Ej: Fachada norte' }],
      confirmLabel: 'Crear',
    });
    if (result && result.name) {
      await createFolder(result.name, folderId);
      renderFoldersView(container, folderId);
    }
  });

  // Cámara
  container.querySelector('#btn-camera').addEventListener('click', () => {
    navigate(`/camera/${folderId === ROOT_ID ? 'root' : folderId}`);
  });

  // Selección múltiple
  const selectionBar = container.querySelector('#selection-bar');
  const btnSelect = container.querySelector('#btn-select');
  const btnCancelSelect = container.querySelector('#btn-cancel-select');
  const btnExport = container.querySelector('#btn-export');
  const selectionCount = container.querySelector('#selection-count');

  function setSelectMode(on) {
    selectMode = on;
    container.querySelectorAll('.photo-tile').forEach((tile) => {
      tile.classList.toggle('selectable', on);
      tile.classList.remove('selected');
    });
    selection.clear();
    updateSelectionUI();
    selectionBar.hidden = !on;
  }

  function updateSelectionUI() {
    selectionCount.textContent = `${selection.size} seleccionada${selection.size === 1 ? '' : 's'}`;
    btnExport.textContent = selection.size ? 'Exportar seleccionadas' : 'Exportar todas';
  }

  if (btnSelect) {
    btnSelect.addEventListener('click', () => setSelectMode(true));
  }
  btnCancelSelect.addEventListener('click', () => setSelectMode(false));

  container.querySelectorAll('.photo-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      if (!selectMode) {
        navigate(`/photo/${tile.dataset.photoId}`);
        return;
      }
      const id = tile.dataset.photoId;
      if (selection.has(id)) {
        selection.delete(id);
        tile.classList.remove('selected');
      } else {
        selection.add(id);
        tile.classList.add('selected');
      }
      updateSelectionUI();
    });
  });

  btnExport.addEventListener('click', async () => {
    const photosToExport = selection.size
      ? await getPhotosByIds([...selection])
      : photos;
    if (!photosToExport.length) {
      toast('No hay fotos para exportar.');
      return;
    }
    btnExport.disabled = true;
    btnExport.textContent = 'Generando PDF…';
    try {
      await exportFolderReport({ folderName: currentName, photos: photosToExport });
      toast('Informe PDF generado.');
    } catch (err) {
      console.error(err);
      toast('Error al generar el PDF.');
    } finally {
      setSelectMode(false);
    }
  });

  async function openFolderMenu(folder) {
    const action = await folderActionSheet(folder.name);
    if (action === 'rename') {
      const result = await promptDialog({
        title: 'Renombrar carpeta',
        fields: [{ name: 'name', label: 'Nombre', value: folder.name }],
        confirmLabel: 'Renombrar',
      });
      if (result && result.name) {
        await renameFolder(folder.id, result.name);
        renderFoldersView(container, folderId);
      }
    } else if (action === 'delete') {
      const ok = await confirmDialog(
        `¿Eliminar la carpeta "${folder.name}" y todo su contenido (subcarpetas y fotos)? Esta acción no se puede deshacer.`
      );
      if (ok) {
        await deleteFolderRecursive(folder.id);
        renderFoldersView(container, folderId);
      }
    }
  }
}

function renderPhotoGrid(photos) {
  const grid = document.getElementById('photo-grid');
  grid.innerHTML = photos
    .map((p) => {
      const url = trackURL(URL.createObjectURL(p.blob));
      return `
        <button class="photo-tile" data-photo-id="${p.id}">
          <img src="${url}" alt="${escapeHTML(p.title || 'Foto')}" loading="lazy" />
          <span class="photo-check">✓</span>
        </button>
      `;
    })
    .join('');
}

function renderBreadcrumbs(path) {
  const nav = document.getElementById('breadcrumbs');
  const crumbs = [{ id: null, name: 'Inicio' }, ...path.map((f) => ({ id: f.id, name: f.name }))];
  nav.innerHTML = crumbs
    .map((c, i) => {
      const isLast = i === crumbs.length - 1;
      const href = c.id ? `#/folder/${c.id}` : '#/';
      return isLast
        ? `<span class="crumb crumb-current">${escapeHTML(c.name)}</span>`
        : `<a class="crumb" href="${href}">${escapeHTML(c.name)}</a><span class="crumb-sep">›</span>`;
    })
    .join('');
}

function folderActionSheet(folderName) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal action-sheet" role="dialog" aria-modal="true">
        <h2>${escapeHTML(folderName)}</h2>
        <button class="sheet-action" data-action="rename">✏️ Renombrar</button>
        <button class="sheet-action sheet-danger" data-action="delete">🗑️ Eliminar</button>
        <button class="sheet-action" data-action="cancel">Cancelar</button>
      </div>
    `;
    document.body.appendChild(overlay);

    function cleanup(result) {
      overlay.remove();
      resolve(result);
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
      const btn = e.target.closest('[data-action]');
      if (btn) cleanup(btn.dataset.action === 'cancel' ? null : btn.dataset.action);
    });
  });
}
