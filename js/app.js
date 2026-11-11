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

// Cada vez que se cambia de pantalla se arma un contenedor NUEVO y se descarta
// el anterior. Antes todas las pantallas escribían en el mismo contenedor, y una
// pantalla que terminaba de cargar datos "en segundo plano" (permisos, Drive)
// después de que ya habías entrado a otra le pintaba encima su propio contenido:
// la lista de obras reaparecía sobre la obra, y se perdían los botones hasta
// actualizar. Ahora esa pantalla vieja solo escribe en un contenedor ya descartado.
function nuevaVista() {
  const host = document.createElement('div');
  host.className = 'view-host';
  appEl.replaceChildren(host);
  return host;
}

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

registerRoute('/', () => renderHomeView(nuevaVista()));

// Macro módulos (agrupan los módulos reales de abajo).
registerRoute('/banco', () => renderBancoHomeView(nuevaVista()));
registerRoute('/proyectos', () => renderProyectosHomeView(nuevaVista()));

// Módulo Avance de obra (ex "Proyectos"; fotos → informe PDF). La ruta
// interna sigue siendo /fotos — solo cambió el nombre que ve el usuario.
registerRoute('/fotos', () => renderFoldersView(nuevaVista(), ROOT_ID));
registerRoute('/fotos/folder/:id', ({ id }) => renderFoldersView(nuevaVista(), id));

// Módulo Estudio de mercado (Banco): defensa de tasación por tipología.
registerRoute('/banco/estudio-mercado', () => renderTasacionHomeView(nuevaVista()));
registerRoute('/banco/estudio-mercado/:id', ({ id }) => renderTasacionEstudioView(nuevaVista(), id));
registerRoute('/fotos/camera/:folderId', ({ folderId }) => renderCameraView(nuevaVista(), folderId === 'root' ? ROOT_ID : folderId));
registerRoute('/fotos/photo/:id', ({ id }) => renderPhotoView(nuevaVista(), id));
registerRoute('/fotos/todas/:id', ({ id }) => renderAllPhotosView(nuevaVista(), id === 'root' ? ROOT_ID : id));

// Módulo Protocolos (checklist de calidad + firma digital).
registerRoute('/protocolos', () => renderProtocolHomeView(nuevaVista()));
registerRoute('/protocolos/en-curso', () => renderProtocolDraftsView(nuevaVista()));
registerRoute('/protocolos/obra/:obraId', ({ obraId }) => renderProtocolObraView(nuevaVista(), obraId));
registerRoute('/protocolos/instancia/:id', ({ id }) => renderProtocolFormView(nuevaVista(), id));

// Módulo Control (programación, checklist diario, SSMA, actas, KPI).
registerRoute('/calidad', () => renderQcHomeView(nuevaVista()));
registerRoute('/control/obra/:obraId/calidad', ({ obraId }) => renderQcHomeView(nuevaVista(), obraId));
registerRoute('/calidad/proyecto/:id', ({ id }) => renderQcProjectView(nuevaVista(), id));
registerRoute('/control', () => renderControlHomeView(nuevaVista()));
registerRoute('/control/obra/:obraId', ({ obraId }) => renderControlObraView(nuevaVista(), obraId));
registerRoute('/control/obra/:obraId/personal', ({ obraId }) => renderControlSSMAView(nuevaVista(), obraId));
registerRoute('/control/obra/:obraId/checklist', ({ obraId }) => renderControlChecklistView(nuevaVista(), obraId));
registerRoute('/control/obra/:obraId/checklist/camera', ({ obraId }) => renderChecklistCameraView(nuevaVista(), obraId));
registerRoute('/control/obra/:obraId/avance', ({ obraId }) => renderControlAvanceView(nuevaVista(), obraId));

// Módulo Costos (presupuesto, modificaciones, facturación, reembolsos) —
// "dato rosa": vive adentro de Control (se entra desde la obra de Control,
// no tiene tarjeta propia en el hub de Proyectos), pero sigue protegido con
// su propio permiso — ver nota en controlObraView.js.
registerRoute('/costos/obra/:obraId', ({ obraId }) => renderCostosObraView(nuevaVista(), obraId));

// Módulo RDI (requerimientos de información al mandante) — mismo criterio
// que Costos: se entra desde la obra de Control, no tiene tarjeta propia
// en el hub de Proyectos, y sigue protegido con su propio permiso.
registerRoute('/rdi/obra/:obraId', ({ obraId }) => renderRdiObraView(nuevaVista(), obraId));

// Módulos chicos (directorio, sin permiso propio — ver nota en controlObraView.js).
registerRoute('/subcontratos/obra/:obraId', ({ obraId }) => renderSubcontratosView(nuevaVista(), obraId));
registerRoute('/organismos/obra/:obraId', ({ obraId }) => renderOrganismosView(nuevaVista(), obraId));

// Informe Semanal (acta + compilado + PDF) — reemplaza el placeholder
// "Actas de reunión". Mismo patrón 2 niveles que Protocolos.
registerRoute('/informe-semanal/obra/:obraId', ({ obraId }) => renderInformeSemanalObraView(nuevaVista(), obraId));
registerRoute('/informe-semanal/instancia/:id', ({ id }) => renderInformeSemanalFormView(nuevaVista(), id));
registerRoute('/costos/obra/:obraId/contrato', ({ obraId }) => renderCostosContratoView(nuevaVista(), obraId));
registerRoute('/costos/obra/:obraId/modificaciones', ({ obraId }) => renderCostosModificacionesView(nuevaVista(), obraId));
registerRoute('/costos/obra/:obraId/facturacion', ({ obraId }) => renderCostosFacturacionView(nuevaVista(), obraId));
registerRoute('/costos/obra/:obraId/reembolsos', ({ obraId }) => renderCostosReembolsosView(nuevaVista(), obraId));

registerRoute('/usuarios', () => renderPermissionsAdminView(nuevaVista()));

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
    // Pantallas de inicio y de listas (sin formularios a medio llenar).
    const listScreens = ['', '#/', '#/banco', '#/proyectos', '#/control', '#/calidad', '#/protocolos', '#/costos', '#/rdi'];
    const isObraHome = /^#\/control\/obra\/[^/]+$/.test(hash);
    const isQcList = /^#\/control\/obra\/[^/]+\/calidad$/.test(hash);
    const safeToReload = (listScreens.includes(hash) || isObraHome || isQcList || hash.startsWith('#/fotos')) && !hash.includes('/camera');
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
