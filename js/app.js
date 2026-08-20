import { registerRoute, registerNotFound, startRouter, navigate } from './router.js';
import { ROOT_ID } from './db.js';
import { initSync } from './sync.js';
import { renderHomeView } from './views/homeView.js';
import { renderFoldersView } from './views/foldersView.js';
import { renderCameraView } from './views/cameraView.js';
import { renderPhotoView } from './views/photoView.js';
import { renderProtocolHomeView } from './views/protocolHomeView.js';
import { renderProtocolObraView } from './views/protocolObraView.js';
import { renderProtocolFormView } from './views/protocolFormView.js';
import { renderProtocolDraftsView } from './views/protocolDraftsView.js';
import { renderControlHomeView } from './views/controlHomeView.js';
import { renderControlObraView } from './views/controlObraView.js';
import { renderControlSSMAView } from './views/controlSSMAView.js';

const appEl = document.getElementById('app');

initSync();

registerRoute('/', () => renderHomeView(appEl));

// Módulo Proyectos (fotos → informe PDF).
registerRoute('/fotos', () => renderFoldersView(appEl, ROOT_ID));
registerRoute('/fotos/folder/:id', ({ id }) => renderFoldersView(appEl, id));
registerRoute('/fotos/camera/:folderId', ({ folderId }) => renderCameraView(appEl, folderId === 'root' ? ROOT_ID : folderId));
registerRoute('/fotos/photo/:id', ({ id }) => renderPhotoView(appEl, id));

// Módulo Protocolos (checklist de calidad + firma digital).
registerRoute('/protocolos', () => renderProtocolHomeView(appEl));
registerRoute('/protocolos/en-curso', () => renderProtocolDraftsView(appEl));
registerRoute('/protocolos/obra/:obraId', ({ obraId }) => renderProtocolObraView(appEl, obraId));
registerRoute('/protocolos/instancia/:id', ({ id }) => renderProtocolFormView(appEl, id));

// Módulo Control (programación, checklist diario, SSMA, actas, KPI).
registerRoute('/control', () => renderControlHomeView(appEl));
registerRoute('/control/obra/:obraId', ({ obraId }) => renderControlObraView(appEl, obraId));
registerRoute('/control/obra/:obraId/ssma', ({ obraId }) => renderControlSSMAView(appEl, obraId));

registerNotFound(() => navigate('/'));

startRouter();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.error('Error registrando el Service Worker:', err);
    });
  });
}
