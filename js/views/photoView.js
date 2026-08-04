import { getPhoto, updatePhoto, deletePhoto } from '../db.js';
import { navigate } from '../router.js';
import { promptDialog, confirmDialog, toast, escapeHTML, formatDate as fmtDate } from '../utils.js';

let currentURL = null;

export async function renderPhotoView(container, photoId) {
  if (currentURL) {
    URL.revokeObjectURL(currentURL);
    currentURL = null;
  }

  const photo = await getPhoto(photoId);
  if (!photo) {
    navigate('/fotos');
    return;
  }

  const backPath = photo.folderId ? `/fotos/folder/${photo.folderId}` : '/fotos';
  currentURL = URL.createObjectURL(photo.blob);

  container.innerHTML = `
    <div class="photo-view">
      <header class="app-header">
        <button class="icon-btn" id="btn-back">←</button>
        <span class="header-title">${escapeHTML(photo.title || 'Foto')}</span>
        <div class="header-actions">
          <button class="icon-btn" id="btn-edit" title="Editar">✏️</button>
          <button class="icon-btn" id="btn-delete" title="Eliminar">🗑️</button>
        </div>
      </header>
      <main class="photo-view-content">
        <img src="${currentURL}" alt="${escapeHTML(photo.title || 'Foto')}" />
        <div class="photo-meta">
          <p class="photo-date">${fmtDate(photo.createdAt)}</p>
          ${photo.note ? `<p class="photo-note">${escapeHTML(photo.note)}</p>` : ''}
        </div>
      </main>
    </div>
  `;

  container.querySelector('#btn-back').addEventListener('click', () => navigate(backPath));

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
