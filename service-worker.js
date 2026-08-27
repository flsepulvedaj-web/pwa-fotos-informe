const CACHE_VERSION = 'v89';
const CACHE_NAME = `fotos-informe-shell-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/router.js',
  './js/utils.js',
  './js/pdfExport.js',
  './js/protocolPdfExport.js',
  './js/signaturePad.js',
  './js/reportFormats.js',
  './js/protocolTemplates.js',
  './js/aiAvance.js',
  './js/controlChecklistTemplates.js',
  './js/controlScheduleParser.js',
  './js/controlDashboard.js',
  './js/controlSync.js',
  './js/costosDashboard.js',
  './js/costosSync.js',
  './js/rdiDashboard.js',
  './js/rdiSync.js',
  './js/directorioSync.js',
  './js/informeSemanalPdfExport.js',
  './js/controlReset.js',
  './js/permissions.js',
  './js/obraSync.js',
  './js/googleDrive.js',
  './js/sync.js',
  './js/views/homeView.js',
  './js/views/foldersView.js',
  './js/views/cameraView.js',
  './js/views/photoView.js',
  './js/views/exportView.js',
  './js/views/protocolHomeView.js',
  './js/views/protocolObraView.js',
  './js/views/protocolFormView.js',
  './js/views/protocolDraftsView.js',
  './js/views/controlHomeView.js',
  './js/views/controlObraView.js',
  './js/views/controlSSMAView.js',
  './js/views/controlChecklistView.js',
  './js/views/controlAvanceView.js',
  './js/views/costosObraView.js',
  './js/views/rdiObraView.js',
  './js/views/subcontratosView.js',
  './js/views/organismosView.js',
  './js/views/informeSemanalObraView.js',
  './js/views/informeSemanalFormView.js',
  './js/views/costosContratoView.js',
  './js/views/costosModificacionesView.js',
  './js/views/costosFacturacionView.js',
  './js/views/costosReembolsosView.js',
  './js/views/permissionsAdminView.js',
  './js/views/bancoHomeView.js',
  './js/views/proyectosHomeView.js',
  './vendor/jspdf.umd.min.js',
  './vendor/xlsx.full.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/watermark-logo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return Response.error();
        });
    })
  );
});
