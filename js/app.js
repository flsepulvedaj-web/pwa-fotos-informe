import { registerRoute, registerNotFound, startRouter, navigate } from './router.js';
import { ROOT_ID, getPendingUploads } from './db.js';
import { initSync, onSyncChange } from './sync.js';
import { isSignedIn } from './googleDrive.js';
import { renderHomeView } from './views/homeView.js';
import { renderFoldersView } from './views/foldersView.js';
import { renderCameraView } from './views/cameraView.js';
import { renderPhotoView } from './views/photoView.js';
import { renderAllPhotosView } from './views/allPhotosView.js';
import { renderProtocolHomeView } from './views/protocolHomeView.js';
import { renderProtocolObraView } from './views/protocolObraView.js';
import { renderProtocolFormView } from './views/protocolFormView.js';
import { renderProtocolDraftsView } from './views/protocolDraftsView.js';
import { renderControlHomeView } from './views/controlHomeView.js';
import { renderControlObraView } from './views/controlObraView.js';
import { renderControlSSMAView } from './views/controlSSMAView.js';
import { renderControlChecklistView } from './views/controlChecklistView.js';
import { renderChecklistCameraView } from './views/checklistCameraView.js';
import { renderControlAvanceView } from './views/controlAvanceView.js';
import { renderCostosObraView } from './views/costosObraView.js';
import { renderRdiObraView } from './views/rdiObraView.js';
import { renderSubcontratosView } from './views/subcontratosView.js';
import { renderOrganismosView } from './views/organismosView.js';
import { renderInformeSemanalObraView } from './views/informeSemanalObraView.js';
import { renderInformeSemanalFormView } from './views/informeSemanalFormView.js';
import { renderCostosContratoView } from './views/costosContratoView.js';
import { renderCostosModificacionesView } from './views/costosModificacionesView.js';
import { renderCostosFacturacionView } from './views/costosFacturacionView.js';
import { renderCostosReembolsosView } from './views/costosReembolsosView.js';
import { renderPermissionsAdminView } from './views/permissionsAdminView.js';
import { renderBancoHomeView } from './views/bancoHomeView.js';
import { renderProyectosHomeView } from './views/proyectosHomeView.js';
import { renderTasacionHomeView } from './views/tasacionHomeView.js';
import { renderTasacionEstudioView } from './views/tasacionEstudioView.js';
import { renderQcHomeView } from './views/qcHomeView.js';
import { renderQcProjectView } from './views/qcProjectView.js';

const appEl = document.getElementById('app');

initSync();

// Aviso flotante con cuántas fotos faltan por subir a Drive. La subida solo
// avanza con la app abierta, y sin este aviso nadie se entera de que falta.
const uploadPill = document.createElement('div');
uploadPill.className = 'upload-pill';
uploadPill.hidden = true;
document.body.appendChild(uploadPill);

async function refreshUploadPill() {
  try {
    const pending = (await getPendingUploads()).length;
    if (!pending) {
      uploadPill.hidden = true;
      return;
    }
    uploadPill.textContent = isSignedIn()
      ? `⬆️ Subiendo ${pending} foto${pending === 1 ? '' : 's'} a Drive… deja la app abierta`
      : `⚠️ ${pending} foto${pending === 1 ? '' : 's'} sin subir — falta iniciar sesión con Google`;
    uploadPill.hidden = false;
  } catch {
    uploadPill.hidden = true;
  }
}
onSyncChange(refreshUploadPill);
refreshUploadPill();
setInterval(refreshUploadPill, 5000);

registerRoute('/', () => renderHomeView(appEl));

// Macro módulos (agrupan los módulos reales de abajo).
registerRoute('/banco', () => renderBancoHomeView(appEl));
registerRoute('/proyectos', () => renderProyectosHomeView(appEl));

// Módulo Avance de obra (ex "Proyectos"; fotos → informe PDF). La ruta
// interna sigue siendo /fotos — solo cambió el nombre que ve el usuario.
registerRoute('/fotos', () => renderFoldersView(appEl, ROOT_ID));
registerRoute('/fotos/folder/:id', ({ id }) => renderFoldersView(appEl, id));

// Módulo Estudio de mercado (Banco): defensa de tasación por tipología.
registerRoute('/banco/estudio-mercado', () => renderTasacionHomeView(appEl));
registerRoute('/banco/estudio-mercado/:id', ({ id }) => renderTasacionEstudioView(appEl, id));
registerRoute('/fotos/camera/:folderId', ({ folderId }) => renderCameraView(appEl, folderId === 'root' ? ROOT_ID : folderId));
registerRoute('/fotos/photo/:id', ({ id }) => renderPhotoView(appEl, id));
registerRoute('/fotos/todas/:id', ({ id }) => renderAllPhotosView(appEl, id === 'root' ? ROOT_ID : id));

// Módulo Protocolos (checklist de calidad + firma digital).
registerRoute('/protocolos', () => renderProtocolHomeView(appEl));
registerRoute('/protocolos/en-curso', () => renderProtocolDraftsView(appEl));
registerRoute('/protocolos/obra/:obraId', ({ obraId }) => renderProtocolObraView(appEl, obraId));
registerRoute('/protocolos/instancia/:id', ({ id }) => renderProtocolFormView(appEl, id));

// Módulo Control (programación, checklist diario, SSMA, actas, KPI).
registerRoute('/calidad', () => renderQcHomeView(appEl));
registerRoute('/control/obra/:obraId/calidad', ({ obraId }) => renderQcHomeView(appEl, obraId));
registerRoute('/calidad/proyecto/:id', ({ id }) => renderQcProjectView(appEl, id));
registerRoute('/control', () => renderControlHomeView(appEl));
registerRoute('/control/obra/:obraId', ({ obraId }) => renderControlObraView(appEl, obraId));
registerRoute('/control/obra/:obraId/personal', ({ obraId }) => renderControlSSMAView(appEl, obraId));
registerRoute('/control/obra/:obraId/checklist', ({ obraId }) => renderControlChecklistView(appEl, obraId));
registerRoute('/control/obra/:obraId/checklist/camera', ({ obraId }) => renderChecklistCameraView(appEl, obraId));
registerRoute('/control/obra/:obraId/avance', ({ obraId }) => renderControlAvanceView(appEl, obraId));

// Módulo Costos (presupuesto, modificaciones, facturación, reembolsos) —
// "dato rosa": vive adentro de Control (se entra desde la obra de Control,
// no tiene tarjeta propia en el hub de Proyectos), pero sigue protegido con
// su propio permiso — ver nota en controlObraView.js.
registerRoute('/costos/obra/:obraId', ({ obraId }) => renderCostosObraView(appEl, obraId));

// Módulo RDI (requerimientos de información al mandante) — mismo criterio
// que Costos: se entra desde la obra de Control, no tiene tarjeta propia
// en el hub de Proyectos, y sigue protegido con su propio permiso.
registerRoute('/rdi/obra/:obraId', ({ obraId }) => renderRdiObraView(appEl, obraId));

// Módulos chicos (directorio, sin permiso propio — ver nota en controlObraView.js).
registerRoute('/subcontratos/obra/:obraId', ({ obraId }) => renderSubcontratosView(appEl, obraId));
registerRoute('/organismos/obra/:obraId', ({ obraId }) => renderOrganismosView(appEl, obraId));

// Informe Semanal (acta + compilado + PDF) — reemplaza el placeholder
// "Actas de reunión". Mismo patrón 2 niveles que Protocolos.
registerRoute('/informe-semanal/obra/:obraId', ({ obraId }) => renderInformeSemanalObraView(appEl, obraId));
registerRoute('/informe-semanal/instancia/:id', ({ id }) => renderInformeSemanalFormView(appEl, id));
registerRoute('/costos/obra/:obraId/contrato', ({ obraId }) => renderCostosContratoView(appEl, obraId));
registerRoute('/costos/obra/:obraId/modificaciones', ({ obraId }) => renderCostosModificacionesView(appEl, obraId));
registerRoute('/costos/obra/:obraId/facturacion', ({ obraId }) => renderCostosFacturacionView(appEl, obraId));
registerRoute('/costos/obra/:obraId/reembolsos', ({ obraId }) => renderCostosReembolsosView(appEl, obraId));

registerRoute('/usuarios', () => renderPermissionsAdminView(appEl));

registerNotFound(() => navigate('/'));

startRouter();

if ('serviceWorker' in navigator) {
  // Antes, después de publicar una versión nueva había que cerrar y abrir la
  // app dos veces para que la usara (la página ya cargada seguía con el
  // código viejo). Ahora, cuando la versión nueva toma el control, se recarga
  // sola una vez. Solo en pantallas sin nada que se pueda perder (inicio y
  // fotos, menos la cámara); en otras queda para la próxima vez que se abra.
  const hadController = !!navigator.serviceWorker.controller;
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloadedForUpdate) return;
    const hash = location.hash;
    const safeToReload = (hash === '' || hash === '#/' || hash.startsWith('#/fotos')) && !hash.includes('/camera');
    if (!safeToReload) return;
    reloadedForUpdate = true;
    location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('service-worker.js')
      .then((registration) => {
        // Las apps instaladas casi nunca se cierran del todo: buscar versión
        // nueva también cada vez que la app vuelve a primer plano.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') registration.update().catch(() => {});
        });
        registration.update().catch(() => {});
      })
      .catch((err) => {
        console.error('Error registrando el Service Worker:', err);
      });
  });
}
