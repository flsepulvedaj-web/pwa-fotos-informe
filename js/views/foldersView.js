import {
  ROOT_ID,
  getChildFolders,
  getFolderPath,
  createFolder,
  updateFolder,
  deleteFolderRecursive,
  getPhotosByFolder,
  getPhotosByIds,
  getAllFolders,
  movePhotos,
  deletePhoto,
} from '../db.js';
import { navigate } from '../router.js';
import { promptDialog, confirmDialog, toast, escapeHTML } from '../utils.js';
import { exportFolderReport } from './exportView.js';
import { openFolderPicker } from '../googleDrive.js';
import { trySync, syncFoldersFromDrive, createMatchingDriveFolder } from '../sync.js';

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

  const currentFolder = path.length
    ? path[path.length - 1]
    : { id: ROOT_ID, name: 'Inicio', description: '' };
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
              ${f.driveFolderId ? '<span class="folder-drive-badge" title="Enlazada con Google Drive">☁️</span>' : ''}
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
        <button class="icon-text-btn" id="btn-move" title="Mover a carpeta">📂<span>Mover</span></button>
        <button class="icon-text-btn icon-text-danger" id="btn-delete-selection" title="Eliminar">🗑️<span>Eliminar</span></button>
        <button class="btn btn-secondary" id="btn-cancel-select">Cancelar</button>
        <button class="btn btn-primary" id="btn-export">Exportar PDF</button>
      </div>
    </div>
  `;

  renderBreadcrumbs(path);
  if (photos.length) renderPhotoGrid(photos);
  trySync();
  if (currentFolder.driveFolderId) {
    syncFoldersFromDrive(currentFolder).then((foundNew) => {
      if (foundNew) renderFoldersView(container, folderId);
    });
  }

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
      fields: [
        { name: 'name', label: 'Nombre', placeholder: 'Ej: Fachada norte' },
        { name: 'description', label: 'Descripción (para el informe)', placeholder: 'Ej: Revisión estructural del sector norte', type: 'textarea' },
      ],
      confirmLabel: 'Crear',
    });
    if (result && result.name) {
      const newFolder = await createFolder(result.name, folderId, result.description);
      if (currentFolder.driveFolderId) {
        await createMatchingDriveFolder(newFolder, currentFolder);
      }
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
  const btnMove = container.querySelector('#btn-move');
  const btnDeleteSelection = container.querySelector('#btn-delete-selection');
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
    btnMove.disabled = selection.size === 0;
    btnDeleteSelection.disabled = selection.size === 0;
  }

  if (btnSelect) {
    btnSelect.addEventListener('click', () => setSelectMode(true));
  }
  btnCancelSelect.addEventListener('click', () => setSelectMode(false));

  container.querySelectorAll('.photo-tile').forEach((tile) => {
    let longPressTimer = null;
    let longPressFired = false;
    let startX = 0;
    let startY = 0;
    const MOVE_TOLERANCE = 12; // px — el dedo tiembla un poco aunque "no se mueva"

    const selectThisTile = () => {
      const id = tile.dataset.photoId;
      if (!selection.has(id)) {
        selection.add(id);
        tile.classList.add('selected');
      }
      updateSelectionUI();
    };

    tile.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      longPressFired = false;
      longPressTimer = setTimeout(() => {
        longPressFired = true;
        if (navigator.vibrate) navigator.vibrate(15);
        if (!selectMode) setSelectMode(true);
        selectThisTile();
      }, 450);
    });
    const cancelLongPress = () => clearTimeout(longPressTimer);
    tile.addEventListener('pointerup', cancelLongPress);
    tile.addEventListener('pointercancel', cancelLongPress);
    tile.addEventListener('pointerleave', cancelLongPress);
    tile.addEventListener('pointermove', (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) > MOVE_TOLERANCE) cancelLongPress();
    });
    // El navegador muestra su propio menú (Compartir/Copiar/Ver imagen) al
    // mantener presionado sobre una <img>; lo bloqueamos porque el gesto ya
    // lo usamos nosotros para entrar en modo selección.
    tile.addEventListener('contextmenu', (e) => e.preventDefault());

    tile.addEventListener('click', () => {
      if (longPressFired) {
        longPressFired = false;
        return;
      }
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
      await exportFolderReport({ folder: currentFolder, photos: photosToExport });
      toast('Informe PDF generado.');
    } catch (err) {
      console.error(err);
      toast('Error al generar el PDF.');
    } finally {
      setSelectMode(false);
    }
  });

  btnDeleteSelection.addEventListener('click', async () => {
    if (!selection.size) return;
    const ok = await confirmDialog(`¿Eliminar ${selection.size} foto${selection.size === 1 ? '' : 's'}? Esta acción no se puede deshacer.`);
    if (!ok) return;
    for (const id of selection) {
      await deletePhoto(id);
    }
    toast('Fotos eliminadas.');
    renderFoldersView(container, folderId);
  });

  btnMove.addEventListener('click', async () => {
    if (!selection.size) return;
    const targetId = await folderPickerDialog(folderId);
    if (targetId === null) return;
    await movePhotos([...selection], targetId);
    toast('Fotos movidas.');
    renderFoldersView(container, folderId);
  });

  async function openFolderMenu(folder) {
    const action = await folderActionSheet(folder);
    if (action === 'link-drive') {
      try {
        const picked = await openFolderPicker();
        if (picked) {
          await updateFolder(folder.id, { driveFolderId: picked.id, driveFolderName: picked.name });
          toast(`Enlazada con "${picked.name}" de Drive.`);
          renderFoldersView(container, folderId);
        }
      } catch (err) {
        console.error(err);
        toast('No se pudo conectar con Google Drive.');
      }
    } else if (action === 'unlink-drive') {
      const ok = await confirmDialog('¿Desenlazar esta carpeta de Google Drive? Las fotos ya subidas quedan como están; las nuevas dejarán de subirse solas.');
      if (ok) {
        await updateFolder(folder.id, { driveFolderId: null, driveFolderName: null });
        toast('Carpeta desenlazada.');
        renderFoldersView(container, folderId);
      }
    } else if (action === 'edit') {
      const result = await promptDialog({
        title: 'Editar carpeta',
        fields: [
          { name: 'name', label: 'Nombre', value: folder.name },
          { name: 'description', label: 'Descripción (para el informe)', value: folder.description || '', type: 'textarea' },
        ],
        confirmLabel: 'Guardar',
      });
      if (result && result.name) {
        await updateFolder(folder.id, { name: result.name, description: result.description });
        renderFoldersView(container, folderId);
      }
    } else if (action === 'export') {
      const folderPhotos = await getPhotosByFolder(folder.id);
      if (!folderPhotos.length) {
        toast('Esa carpeta no tiene fotos.');
        return;
      }
      toast('Generando PDF…');
      try {
        await exportFolderReport({ folder, photos: folderPhotos });
        toast('Informe PDF generado.');
      } catch (err) {
        console.error(err);
        toast('Error al generar el PDF.');
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

const SYNC_ICONS = {
  pending: { icon: '⏳', title: 'Esperando subir a Drive' },
  synced: { icon: '☁️', title: 'Respaldada en Drive' },
  error: { icon: '⚠️', title: 'No se pudo subir a Drive, se reintentará' },
};

function renderPhotoGrid(photos) {
  const grid = document.getElementById('photo-grid');
  grid.innerHTML = photos
    .map((p) => {
      const url = trackURL(URL.createObjectURL(p.blob));
      const sync = SYNC_ICONS[p.syncStatus];
      return `
        <button class="photo-tile" data-photo-id="${p.id}">
          <img src="${url}" alt="${escapeHTML(p.title || 'Foto')}" loading="lazy" draggable="false" />
          <span class="photo-check">✓</span>
          ${sync ? `<span class="sync-badge" title="${sync.title}">${sync.icon}</span>` : ''}
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

function folderActionSheet(folder) {
  const driveAction = folder.driveFolderId
    ? `<button class="sheet-action" data-action="unlink-drive">☁️ Enlazada con "${escapeHTML(folder.driveFolderName || 'Drive')}" — Desenlazar</button>`
    : `<button class="sheet-action" data-action="link-drive">☁️ Enlazar con Google Drive</button>`;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal action-sheet" role="dialog" aria-modal="true">
        <h2>${escapeHTML(folder.name)}</h2>
        <button class="sheet-action" data-action="edit">✏️ Editar (nombre / descripción)</button>
        <button class="sheet-action" data-action="export">📄 Exportar PDF</button>
        ${driveAction}
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

// Devuelve el id de carpeta elegido (ROOT_ID para Inicio), o null si se cancela.
async function folderPickerDialog(excludeId) {
  const allFolders = await getAllFolders();
  const options = [{ id: ROOT_ID, name: 'Inicio', depth: 0 }, ...allFolders].filter(
    (f) => f.id !== excludeId
  );

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal folder-picker" role="dialog" aria-modal="true">
        <h2>Mover a…</h2>
        <div class="folder-picker-list">
          ${options.map((f) => `
            <button class="folder-picker-item" data-folder-id="${f.id}" style="padding-left:${16 + f.depth * 18}px">
              📁 ${escapeHTML(f.name)}
            </button>
          `).join('')}
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-action="cancel">Cancelar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    function cleanup(result) {
      overlay.remove();
      resolve(result);
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
      const cancelBtn = e.target.closest('[data-action="cancel"]');
      if (cancelBtn) cleanup(null);
      const item = e.target.closest('.folder-picker-item');
      if (item) cleanup(item.dataset.folderId);
    });
  });
}
