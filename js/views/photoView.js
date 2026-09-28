import { getPhoto, updatePhoto, deletePhoto } from '../db.js';
import { navigate } from '../router.js';
import { promptDialog, confirmDialog, toast, escapeHTML, formatDate as fmtDate, rotateImageBlob } from '../utils.js';
import { updateFileContent } from '../googleDrive.js';

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
          <button class="icon-btn" id="btn-rotate-left" title="Rotar a la izquierda">↺</button>
          <button class="icon-btn" id="btn-rotate-right" title="Rotar a la derecha">↻</button>
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

  async function rotate(direction) {
    try {
      const rotatedBlob = await rotateImageBlob(photo.blob, direction);
      if (photo.driveFileId) {
        // Ya subida a Drive: se reemplaza el mismo archivo — dejarla en
        // 'pending' la subiría de nuevo como archivo NUEVO (duplicado).
        try {
          await updateFileContent(photo.driveFileId, rotatedBlob);
          await updatePhoto(photoId, { blob: rotatedBlob, driveModifiedTime: new Date().toISOString() });
        } catch (err) {
          console.error('No se pudo actualizar la foto en Drive:', err);
          await updatePhoto(photoId, { blob: rotatedBlob });
          toast('Se rotó en el teléfono, pero no se pudo actualizar en Drive (se reintenta después).');
        }
      } else {
        await updatePhoto(photoId, { blob: rotatedBlob });
      }
      renderPhotoView(container, photoId);
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
