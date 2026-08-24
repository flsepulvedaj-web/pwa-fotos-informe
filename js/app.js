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
import { renderControlChecklistView } from './views/controlChecklistView.js';
import { renderControlAvanceView } from './views/controlAvanceView.js';
import { renderCostosObraView } from './views/costosObraView.js';
import { renderCostosContratoView } from './views/costosContratoView.js';
import { renderCostosModificacionesView } from './views/costosModificacionesView.js';
import { renderCostosFacturacionView } from './views/costosFacturacionView.js';
import { renderCostosReembolsosView } from './views/costosReembolsosView.js';
import { renderPermissionsAdminView } from './views/permissionsAdminView.js';
import { renderBancoHomeView } from './views/bancoHomeView.js';
import { renderProyectosHomeView } from './views/proyectosHomeView.js';

const appEl = document.getElementById('app');

initSync();

registerRoute('/', () => renderHomeView(appEl));

// Macro módulos (agrupan los módulos reales de abajo).
registerRoute('/banco', () => renderBancoHomeView(appEl));
registerRoute('/proyectos', () => renderProyectosHomeView(appEl));

// Módulo Avance de obra (ex "Proyectos"; fotos → informe PDF). La ruta
// interna sigue siendo /fotos — solo cambió el nombre que ve el usuario.
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
registerRoute('/control/obra/:obraId/personal', ({ obraId }) => renderControlSSMAView(appEl, obraId));
registerRoute('/control/obra/:obraId/checklist', ({ obraId }) => renderControlChecklistView(appEl, obraId));
registerRoute('/control/obra/:obraId/avance', ({ obraId }) => renderControlAvanceView(appEl, obraId));

// Módulo Costos (presupuesto, modificaciones, facturación, reembolsos) —
// "dato rosa": vive adentro de Control (se entra desde la obra de Control,
// no tiene tarjeta propia en el hub de Proyectos), pero sigue protegido con
// su propio permiso — ver nota en controlObraView.js.
registerRoute('/costos/obra/:obraId', ({ obraId }) => renderCostosObraView(appEl, obraId));
registerRoute('/costos/obra/:obraId/contrato', ({ obraId }) => renderCostosContratoView(appEl, obraId));
registerRoute('/costos/obra/:obraId/modificaciones', ({ obraId }) => renderCostosModificacionesView(appEl, obraId));
registerRoute('/costos/obra/:obraId/facturacion', ({ obraId }) => renderCostosFacturacionView(appEl, obraId));
registerRoute('/costos/obra/:obraId/reembolsos', ({ obraId }) => renderCostosReembolsosView(appEl, obraId));

registerRoute('/usuarios', () => renderPermissionsAdminView(appEl));

registerNotFound(() => navigate('/'));

startRouter();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.error('Error registrando el Service Worker:', err);
    });
  });
}
