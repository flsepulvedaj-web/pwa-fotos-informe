import { registerRoute, registerNotFound, startRouter, navigate } from './router.js';
import { ROOT_ID } from './db.js';
import { renderFoldersView } from './views/foldersView.js';
import { renderCameraView } from './views/cameraView.js';
import { renderPhotoView } from './views/photoView.js';

const appEl = document.getElementById('app');

registerRoute('/', () => renderFoldersView(appEl, ROOT_ID));
registerRoute('/folder/:id', ({ id }) => renderFoldersView(appEl, id));
registerRoute('/camera/:folderId', ({ folderId }) => renderCameraView(appEl, folderId === 'root' ? ROOT_ID : folderId));
registerRoute('/photo/:id', ({ id }) => renderPhotoView(appEl, id));

registerNotFound(() => navigate('/'));

startRouter();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.error('Error registrando el Service Worker:', err);
    });
  });
}
