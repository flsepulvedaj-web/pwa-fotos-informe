import {
  ROOT_ID,
  getFolder,
  getChildFolders,
  getFolderPath,
  createFolder,
  updateFolder,
  deleteFolderRecursive,
  getPhotosByFolder,
  getPhotosByIds,
  getPhotoCountByFolderRecursive,
  getAllFolders,
  getPinnedFolders,
  movePhotos,
  deletePhoto,
  addPhoto,
} from '../db.js';
import { navigate } from '../router.js';
import { promptDialog, confirmDialog, toast, escapeHTML, downscaleImageBlob } from '../utils.js';
import { openExportReviewScreen } from './exportView.js';
import {
  openFolderPicker,
  getDriveRootFolder,
  setDriveRootFolder,
  clearDriveRootFolder,
  getSignedInEmail,
  signIn,
  isSignedIn,
} from '../googleDrive.js';
import { trySync, syncDriveTreeRecursive, deduplicatePhotosRecursive, createMatchingDriveFolder } from '../sync.js';
import { isAiAvanceGroup, openAiAvanceFlow, openAiAvanceMultiFlow, openSameAdvanceMultiFlow } from '../aiAvance.js';
import { isAdmin } from '../permissions.js';

let objectURLs = [];

function trackURL(url) {
  objectURLs.push(url);
  return url;
}

function revokeAllURLs() {
  objectURLs.forEach((u) => URL.revokeObjectURL(u));
  objectURLs = [];
}

// Cada llamada a renderFoldersView (cada vez que se entra a una carpeta de
// verdad) marca la vista actual con un número nuevo. Un repintado que
// llega tarde desde una sincronización en el fondo (después de que Pancho
// ya se movió a otra carpeta) compara su número contra este y, si ya no
// coincide, se salta el repintado — así nunca "secuestra" la navegación
// devolviéndolo a la carpeta anterior de golpe.
let activeViewToken = 0;

export async function renderFoldersView(container, folderId) {
  const myViewToken = ++activeViewToken;
  revokeAllURLs();

  const [path, subfolders, photos, pinnedFolders] = await Promise.all([
    getFolderPath(folderId),
    getChildFolders(folderId),
    getPhotosByFolder(folderId),
    getPinnedFolders(),
  ]);
  const shortcutFolders = pinnedFolders.filter((f) => f.id !== folderId);
  // Las carpetas fijadas ya tienen su acceso directo permanente (el ícono de
  // libro); se ocultan de la lista normal para no verlas duplicadas.
  const visibleSubfolders = subfolders.filter((f) => !f.pinned);
  // Para saber de un vistazo qué carpetas ya tienen fotos adentro (ej. en un
  // loteo con muchas casas, cuáles ya se visitaron) — solo el número, no las
  // fotos completas, para que no sea lento con muchas carpetas.
  const subfolderPhotoCounts = Object.fromEntries(
    await Promise.all(visibleSubfolders.map(async (f) => [f.id, await getPhotoCountByFolderRecursive(f.id)]))
  );

  const currentFolder = path.length
    ? path[path.length - 1]
    : { id: ROOT_ID, name: 'Inicio', description: '' };
  // La sincronización automática nunca pide sesión sola (ver sync.js), así
  // que una foto 'pending' sin sesión vigente se queda ahí sin avisar por
  // su cuenta — por eso el banner también se fija si hace falta reconectar,
  // no solo si ya hubo un 'error'.
  const errorPhotosCount = photos.filter((p) => p.syncStatus === 'error').length;
  const pendingPhotosCount = photos.filter((p) => p.syncStatus === 'pending').length;
  const needsReconnect = pendingPhotosCount > 0 && !isSignedIn();
  const retryBannerCount = errorPhotosCount + (needsReconnect ? pendingPhotosCount : 0);
  // Carpetas borradas/nuevas en Drive tampoco se detectan sin sesión vigente
  // — y a diferencia de las fotos pendientes, eso no deja ningún rastro
  // visible en esta carpeta si no tiene fotos propias. Por eso este aviso es
  // aparte: se muestra igual aunque no haya ninguna foto pendiente.
  const driveDisconnected = !!currentFolder.driveFolderId && !isSignedIn();
  const showSyncBanner = retryBannerCount > 0 || driveDisconnected;
  const syncBannerMessage = retryBannerCount > 0
    ? `⚠️ ${retryBannerCount} foto(s) no se ${retryBannerCount === 1 ? 'ha' : 'han'} subido a Drive todavía${needsReconnect ? ' (hay que reconectar)' : ''}.`
    : '☁️ Sesión de Drive vencida — toca "Reintentar" para traer los últimos cambios (carpetas borradas o nuevas, fotos).';
  const selection = new Set();
  let selectMode = false;
  const folderSelection = new Set();
  let folderSelectMode = false;
  const isRootAdmin = folderId === ROOT_ID && isAdmin(await getSignedInEmail());

  container.innerHTML = `
    <header class="app-header">
      ${folderId === ROOT_ID ? '<button class="icon-btn" id="btn-back-home" title="Volver al inicio">←</button>' : ''}
      <nav class="breadcrumbs" id="breadcrumbs"></nav>
      <div class="header-actions">
        ${folderId !== ROOT_ID ? '<button class="icon-btn" id="btn-folder-menu" title="Opciones de la carpeta">⋮</button>' : ''}
        ${isRootAdmin ? '<button class="icon-btn" id="btn-drive-settings" title="Configurar Google Drive">⚙️</button>' : ''}
        <button class="icon-btn" id="btn-select" title="Seleccionar" ${photos.length ? '' : 'disabled'}>✓</button>
      </div>
    </header>

    <main class="view-content">
      ${visibleSubfolders.length ? `
        <section class="folder-grid">
          ${visibleSubfolders.map((f) => `
            <button class="folder-tile" data-folder-id="${f.id}">
              <span class="folder-icon">📁</span>
              ${f.driveFolderId ? '<span class="folder-drive-badge" title="Enlazada con Google Drive">☁️</span>' : ''}
              ${subfolderPhotoCounts[f.id] ? `<span class="folder-photo-badge" title="${subfolderPhotoCounts[f.id]} foto(s)">✓ ${subfolderPhotoCounts[f.id]}</span>` : ''}
              <span class="folder-name">${escapeHTML(f.name)}</span>
              <span class="folder-menu" data-menu-folder-id="${f.id}">⋮</span>
              <span class="folder-check">✓</span>
            </button>
          `).join('')}
        </section>
      ` : ''}

      ${showSyncBanner ? `
        <div class="sync-retry-banner">
          <span>${syncBannerMessage}</span>
          <button type="button" class="btn btn-secondary" id="btn-retry-sync">Reintentar</button>
        </div>
      ` : ''}

      ${photos.length ? `
        <section class="photo-grid" id="photo-grid"></section>
      ` : `
        ${visibleSubfolders.length === 0 ? `
          <div class="empty-state">
            <p>Esta carpeta está vacía.</p>
            <p>Crea una subcarpeta o toma una foto para empezar.</p>
          </div>
        ` : ''}
      `}
    </main>

    <div class="fab-row">
      ${shortcutFolders.map((f) => `
        <button class="fab fab-secondary" data-shortcut-folder-id="${f.id}" title="${escapeHTML(f.name)}">📖</button>
      `).join('')}
      <button class="fab fab-secondary" id="btn-new-folder" title="Nueva carpeta">📁➕</button>
      <button class="fab fab-secondary" id="btn-gallery" title="Elegir foto de la galería">🖼️</button>
      <button class="fab fab-primary" id="btn-camera" title="Tomar foto">📷</button>
    </div>
    <input type="file" id="gallery-input" accept="image/*" multiple hidden />

    <div class="selection-bar" id="selection-bar" hidden>
      <span id="selection-count">0 seleccionadas</span>
      <div class="selection-actions">
        <button class="icon-text-btn" id="btn-move" title="Mover a carpeta">📂<span>Mover</span></button>
        <button class="icon-text-btn icon-text-danger" id="btn-delete-selection" title="Eliminar">🗑️<span>Eliminar</span></button>
        <button class="btn btn-secondary" id="btn-cancel-select">Cancelar</button>
        <button class="btn btn-primary" id="btn-export">Exportar PDF</button>
      </div>
    </div>

    <div class="selection-bar" id="folder-selection-bar" hidden>
      <span id="folder-selection-count">0 seleccionadas</span>
      <div class="selection-actions">
        <button class="btn btn-secondary" id="btn-cancel-folder-select">Cancelar</button>
        <button class="btn btn-secondary" id="btn-export-folders-same">🏢 Mismo avance</button>
        <button class="btn btn-secondary" id="btn-export-folders-ai">🤖 IA combinado</button>
        <button class="btn btn-primary" id="btn-export-folders">Exportar combinado</button>
      </div>
    </div>
  `;

  renderBreadcrumbs(path);
  if (photos.length) renderPhotoGrid(photos);
  trySync();

  // Reintentar subida: acá SÍ se puede pedir sesión de Google si venció —
  // es un clic directo del usuario, así que el navegador deja abrir la
  // ventanita (trySync() solo, corriendo en segundo plano, no puede).
  container.querySelector('#btn-retry-sync')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Conectando…';
    try {
      await signIn();
    } catch (err) {
      console.error(err);
      toast('No se pudo conectar con Google.');
      btn.disabled = false;
      btn.textContent = 'Reintentar';
      return;
    }
    btn.textContent = 'Sincronizando…';
    await syncDriveTreeRecursive(currentFolder); // carpetas borradas/nuevas + fotos subidas directo en Drive
    btn.textContent = 'Subiendo…';
    await trySync(); // fotos pendientes de subir
    renderFoldersView(container, folderId);
  });
  if (currentFolder.driveFolderId) {
    // En árboles grandes (varias torres/pisos) esto puede demorar minutos —
    // sin avisar nada mientras tanto, parece que la app quedó pegada y
    // Pancho terminaba refrescando la página (lo que en realidad reinicia
    // la sincronización desde cero). Por eso: un aviso al partir, y la
    // pantalla se va actualizando sola a medida que van llegando carpetas,
    // sin interrumpir si está en medio de una selección.
    let progressNotified = false;
    let lastProgressRender = Date.now();
    syncDriveTreeRecursive(currentFolder, () => {
      if (!progressNotified) {
        progressNotified = true;
        toast('🔄 Sincronizando con Drive… puede demorar si hay muchas fotos.');
      }
      // Si Pancho ya se movió a otra carpeta mientras esto seguía corriendo
      // en el fondo, este repintado quedó atrasado — nunca lo devolvemos a
      // la carpeta vieja de golpe.
      if (myViewToken !== activeViewToken) return;
      const now = Date.now();
      if (now - lastProgressRender > 1500 && !selectMode && !folderSelectMode) {
        lastProgressRender = now;
        renderFoldersView(container, folderId);
      }
    }).then((totals) => {
      const notices = [];
      if (totals.downloaded) {
        notices.push(`${totals.downloaded} foto${totals.downloaded === 1 ? '' : 's'} nueva${totals.downloaded === 1 ? '' : 's'} desde Drive`);
      }
      if (totals.deletedCount) {
        notices.push(`${totals.deletedCount} carpeta${totals.deletedCount === 1 ? '' : 's'} borrada${totals.deletedCount === 1 ? '' : 's'} (ya no estaba${totals.deletedCount === 1 ? '' : 'n'} en Drive)`);
      }
      if (totals.recoveredCount) {
        notices.push(`${totals.recoveredCount} foto${totals.recoveredCount === 1 ? '' : 's'} sin subir se guardó${totals.recoveredCount === 1 ? '' : 'aron'} en "Recuperadas de Drive"`);
      }
      if (notices.length) toast(notices.join(' · '));
      else if (totals.error) toast(`Drive: ${totals.error}`);

      if ((totals.newCount || totals.deletedCount || totals.recoveredCount || totals.downloaded) && myViewToken === activeViewToken) {
        renderFoldersView(container, folderId);
      }
    });
  }

  // Navegación de subcarpetas + selección múltiple (mantener presionada,
  // igual que con las fotos) para exportar varias carpetas combinadas.
  container.querySelectorAll('.folder-tile').forEach((tile) => {
    let longPressTimer = null;
    let longPressFired = false;
    let startX = 0;
    let startY = 0;
    const MOVE_TOLERANCE = 12;

    const selectThisFolder = () => {
      const id = tile.dataset.folderId;
      if (!folderSelection.has(id)) {
        folderSelection.add(id);
        tile.classList.add('selected');
      }
      updateFolderSelectionUI();
    };

    tile.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      longPressFired = false;
      longPressTimer = setTimeout(() => {
        longPressFired = true;
        if (navigator.vibrate) navigator.vibrate(15);
        if (!folderSelectMode) setFolderSelectMode(true);
        selectThisFolder();
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

    tile.addEventListener('click', (e) => {
      if (e.target.classList.contains('folder-menu')) return;
      if (longPressFired) {
        longPressFired = false;
        return;
      }
      if (folderSelectMode) {
        const id = tile.dataset.folderId;
        if (folderSelection.has(id)) {
          folderSelection.delete(id);
          tile.classList.remove('selected');
        } else {
          folderSelection.add(id);
          tile.classList.add('selected');
        }
        updateFolderSelectionUI();
        return;
      }
      navigate(`/fotos/folder/${tile.dataset.folderId}`);
    });
  });

  container.querySelectorAll('.folder-menu').forEach((menu) => {
    menu.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (folderSelectMode) return;
      const id = menu.dataset.menuFolderId;
      const folder = subfolders.find((f) => f.id === id);
      await openFolderMenu(folder);
    });
  });

  const folderSelectionBar = container.querySelector('#folder-selection-bar');
  const folderSelectionCount = container.querySelector('#folder-selection-count');
  const btnCancelFolderSelect = container.querySelector('#btn-cancel-folder-select');
  const btnExportFolders = container.querySelector('#btn-export-folders');
  const btnExportFoldersAI = container.querySelector('#btn-export-folders-ai');
  const btnExportFoldersSame = container.querySelector('#btn-export-folders-same');

  function setFolderSelectMode(on) {
    folderSelectMode = on;
    if (on) setSelectMode(false);
    container.querySelectorAll('.folder-tile').forEach((tile) => {
      tile.classList.toggle('selectable', on);
      tile.classList.remove('selected');
    });
    folderSelection.clear();
    updateFolderSelectionUI();
    folderSelectionBar.hidden = !on;
  }

  function updateFolderSelectionUI() {
    folderSelectionCount.textContent = `${folderSelection.size} seleccionada${folderSelection.size === 1 ? '' : 's'}`;
    btnExportFolders.disabled = folderSelection.size === 0;
    btnExportFoldersAI.disabled = folderSelection.size === 0;
    btnExportFoldersSame.disabled = folderSelection.size === 0;
  }

  btnCancelFolderSelect.addEventListener('click', () => setFolderSelectMode(false));

  btnExportFolders.addEventListener('click', async () => {
    if (!folderSelection.size) return;
    const selectedFolders = (await Promise.all([...folderSelection].map((id) => getFolder(id)))).filter(Boolean);
    const photoArrays = await Promise.all(selectedFolders.map((f) => getPhotosByFolder(f.id)));
    const combinedPhotos = photoArrays.flat();
    if (!combinedPhotos.length) {
      toast('Esas carpetas no tienen fotos.');
      return;
    }
    setFolderSelectMode(false);
    const exported = await openExportReviewScreen(combinedPhotos, { name: '', reportNumber: '', reportPeriod: '' });
    if (exported) renderFoldersView(container, folderId);
  });

  btnExportFoldersAI.addEventListener('click', async () => {
    if (!folderSelection.size) return;
    const selectedFolders = (await Promise.all([...folderSelection].map((id) => getFolder(id)))).filter(Boolean);
    setFolderSelectMode(false);
    await openAiAvanceMultiFlow(selectedFolders);
    renderFoldersView(container, folderId);
  });

  btnExportFoldersSame.addEventListener('click', async () => {
    if (!folderSelection.size) return;
    const selectedFolders = (await Promise.all([...folderSelection].map((id) => getFolder(id)))).filter(Boolean);
    setFolderSelectMode(false);
    await openSameAdvanceMultiFlow(selectedFolders);
    renderFoldersView(container, folderId);
  });

  // Accesos directos (carpetas fijadas)
  container.querySelectorAll('[data-shortcut-folder-id]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(`/fotos/folder/${btn.dataset.shortcutFolderId}`));
  });

  // Opciones de la carpeta actual (útil sobre todo para una fijada, que ya
  // no aparece en ningún listado como para tocar su "⋮")
  const btnFolderMenu = container.querySelector('#btn-folder-menu');
  if (btnFolderMenu) {
    btnFolderMenu.addEventListener('click', () => openFolderMenu(currentFolder));
  }

  // En la raíz no hay carpeta padre a la que "subir" — sin este botón no
  // había forma de volver al Inicio salvo cerrando la app entera.
  container.querySelector('#btn-back-home')?.addEventListener('click', () => navigate('/banco'));

  const btnDriveSettings = container.querySelector('#btn-drive-settings');
  if (btnDriveSettings) {
    btnDriveSettings.addEventListener('click', async () => {
      const root = getDriveRootFolder();
      const action = await driveSettingsSheet(root);
      if (action === 'change') {
        try {
          const picked = await openFolderPicker();
          if (picked) {
            setDriveRootFolder(picked);
            toast(`Carpeta raíz de Drive actualizada a "${picked.name}".`);
          }
        } catch (err) {
          console.error(err);
          toast('No se pudo conectar con Google Drive.');
        }
      } else if (action === 'clear') {
        clearDriveRootFolder();
        toast('Restricción quitada: la próxima vez el selector mostrará todo tu Drive.');
      }
    });
  }

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
    navigate(`/fotos/camera/${folderId === ROOT_ID ? 'root' : folderId}`);
  });

  // Elegir de la galería: para cuando la cámara del navegador no llega al
  // lente que se necesita (ej. angular 0.6x), se puede tomar la foto con la
  // cámara nativa del teléfono y traerla acá — esa sí tiene acceso a todos
  // los lentes del teléfono, sea cual sea el modelo.
  const galleryInput = container.querySelector('#gallery-input');
  container.querySelector('#btn-gallery').addEventListener('click', () => galleryInput.click());
  galleryInput.addEventListener('change', async () => {
    const files = [...galleryInput.files];
    galleryInput.value = '';
    if (!files.length) return;

    const linkedToDrive = !!currentFolder.driveFolderId;
    let added = 0;
    for (const file of files) {
      try {
        const blob = await downscaleImageBlob(file);
        await addPhoto({
          folderId,
          blob,
          title: '',
          note: '',
          syncStatus: linkedToDrive ? 'pending' : null,
        });
        added++;
      } catch (err) {
        console.error('Error importando foto de la galería:', err);
      }
    }
    if (linkedToDrive && added) trySync();
    if (added) toast(added === 1 ? 'Foto agregada.' : `${added} fotos agregadas.`);
    renderFoldersView(container, folderId);
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
    if (on) setFolderSelectMode(false);
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
        navigate(`/fotos/photo/${tile.dataset.photoId}`);
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
    setSelectMode(false);
    const exported = await openExportReviewScreen(photosToExport, currentFolder);
    if (exported) renderFoldersView(container, folderId);
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
    if (action === 'pin') {
      await updateFolder(folder.id, { pinned: true });
      toast(`"${folder.name}" fijada como acceso directo.`);
      renderFoldersView(container, folderId);
    } else if (action === 'unpin') {
      await updateFolder(folder.id, { pinned: false });
      toast('Acceso directo quitado.');
      renderFoldersView(container, folderId);
    } else if (action === 'link-drive') {
      try {
        const root = getDriveRootFolder();
        const picked = await openFolderPicker(root ? root.id : undefined);
        if (picked) {
          await updateFolder(folder.id, { driveFolderId: picked.id, driveFolderName: picked.name });
          if (!root) {
            setDriveRootFolder(picked);
            toast(`"${picked.name}" quedó como tu carpeta raíz de Drive. Desde ahora el selector solo mostrará lo que haya dentro de ella.`);
          } else {
            toast(`Enlazada con "${picked.name}" de Drive.`);
          }
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
      const exported = await openExportReviewScreen(folderPhotos, folder);
      if (exported) renderFoldersView(container, folderId);
    } else if (action === 'ai-avance') {
      await openAiAvanceFlow(folder);
      renderFoldersView(container, folderId);
    } else if (action === 'dedupe') {
      toast('Buscando duplicados…');
      const removed = await deduplicatePhotosRecursive(folder.id);
      toast(removed ? `Se quitaron ${removed} foto(s) duplicada(s).` : 'No había fotos duplicadas.');
      renderFoldersView(container, folderId);
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
      const href = c.id ? `#/fotos/folder/${c.id}` : '#/fotos';
      return isLast
        ? `<span class="crumb crumb-current">${escapeHTML(c.name)}</span>`
        : `<a class="crumb" href="${href}">${escapeHTML(c.name)}</a><span class="crumb-sep">›</span>`;
    })
    .join('');
}

function driveSettingsSheet(root) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal action-sheet" role="dialog" aria-modal="true">
        <h2>Google Drive</h2>
        <p class="modal-message">
          ${root
            ? `El selector está restringido a la carpeta <strong>"${escapeHTML(root.name)}"</strong> — no se puede ver ni elegir nada fuera de ella.`
            : 'Todavía no has enlazado ninguna carpeta, así que el selector no tiene restricción configurada.'}
        </p>
        <button class="sheet-action" data-action="change">📁 ${root ? 'Cambiar' : 'Elegir'} carpeta raíz</button>
        ${root ? '<button class="sheet-action sheet-danger" data-action="clear">🗑️ Quitar restricción</button>' : ''}
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

async function folderActionSheet(folder) {
  const driveAction = folder.driveFolderId
    ? `<button class="sheet-action" data-action="unlink-drive">☁️ Enlazada con "${escapeHTML(folder.driveFolderName || 'Drive')}" — Desenlazar</button>`
    : `<button class="sheet-action" data-action="link-drive">☁️ Enlazar con Google Drive</button>`;
  const pinAction = folder.pinned
    ? `<button class="sheet-action" data-action="unpin">📖 Quitar acceso directo</button>`
    : `<button class="sheet-action" data-action="pin">📖 Fijar como acceso directo</button>`;
  // Solo se ofrece si la carpeta tiene la forma "Calle X"/"Piso Y" (una
  // subcarpeta "Fotos ..." + subcarpetas numeradas) — en cualquier otra
  // carpeta esta acción no tiene sentido y no se muestra.
  const aiAction = (await isAiAvanceGroup(folder))
    ? `<button class="sheet-action" data-action="ai-avance">🤖 Armar informe con IA</button>`
    : '';

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal action-sheet" role="dialog" aria-modal="true">
        <h2>${escapeHTML(folder.name)}</h2>
        <button class="sheet-action" data-action="edit">✏️ Editar (nombre / descripción)</button>
        <button class="sheet-action" data-action="export">📄 Exportar PDF</button>
        ${aiAction}
        ${pinAction}
        ${driveAction}
        ${folder.driveFolderId ? '<button class="sheet-action" data-action="dedupe">🧹 Quitar fotos duplicadas</button>' : ''}
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
