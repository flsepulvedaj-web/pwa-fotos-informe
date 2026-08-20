// Integración con Google Drive: login (Google Identity Services), selector
// de carpeta (Picker API) y subida de archivos (Drive API v3).
// Scope drive (completo, no drive.file): se necesita para que la app pueda
// listar carpetas creadas directo en Drive por el usuario (fuera de la
// app) y así sincronizar en las dos direcciones, no solo app -> Drive.
const CLIENT_ID = '1005265173127-i5lhpkpnmi8mlraev3hvla9p2qrf2v11.apps.googleusercontent.com';
const API_KEY = 'AIzaSyBPOsLlvyl1bPtQxURmf4V-C7pUvLxZl04';
// 'email' además de 'drive': permite saber qué cuenta inició sesión, para
// que solo el correo admin (ver ADMIN_EMAIL en foldersView.js) pueda ver
// la opción de cambiar la carpeta raíz — el resto del equipo la usa fija.
const SCOPE = 'https://www.googleapis.com/auth/drive email';
const TOKEN_STORAGE_KEY = 'gdrive-token-v3';
const ROOT_FOLDER_KEY = 'gdrive-root-folder';
// Raíz de Drive del módulo Protocolos (carpeta "PROTOCOLOS" que Pancho armó
// a mano) — completamente aparte de la raíz de fotos de arriba, sin valor
// por defecto: hay que vincularla una vez desde los ajustes de Protocolos.
const PROTOCOLS_ROOT_FOLDER_KEY = 'gdrive-protocolos-root-folder';

// Carpeta raíz por defecto ("Proyectos LEN", antes "Fotos Proyectos" — el
// nombre se puede cambiar en Drive libremente porque Drive identifica la
// carpeta por su id, no por el nombre; este `name` es solo para mostrar):
// así cualquier compañero que abra la app en su propio teléfono queda
// restringido a esta carpeta desde el primer uso, sin tener que configurar
// nada — nadie más que el admin puede cambiarla (ver getDriveRootFolder).
const DEFAULT_ROOT_FOLDER = { id: '1L0EDZ6eHzqOSxLnOqV2Wd5p8rp6hGsjf', name: 'Proyectos LEN' };

/**
 * Carpeta raíz de Drive a la que queda restringido el selector (para no
 * exponer el resto del Drive personal de quien use la app). Si no hay una
 * guardada localmente, usa la carpeta fija del equipo.
 */
export function getDriveRootFolder() {
  try {
    const raw = localStorage.getItem(ROOT_FOLDER_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignorar datos corruptos
  }
  return DEFAULT_ROOT_FOLDER.id === 'PENDIENTE' ? null : DEFAULT_ROOT_FOLDER;
}

export function setDriveRootFolder(folder) {
  localStorage.setItem(ROOT_FOLDER_KEY, JSON.stringify(folder));
}

export function clearDriveRootFolder() {
  localStorage.removeItem(ROOT_FOLDER_KEY);
}

/** Igual que las tres funciones de arriba, pero para la raíz de Protocolos. */
export function getProtocolsRootFolder() {
  try {
    const raw = localStorage.getItem(PROTOCOLS_ROOT_FOLDER_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignorar datos corruptos
  }
  return null;
}

export function setProtocolsRootFolder(folder) {
  localStorage.setItem(PROTOCOLS_ROOT_FOLDER_KEY, JSON.stringify(folder));
}

export function clearProtocolsRootFolder() {
  localStorage.removeItem(PROTOCOLS_ROOT_FOLDER_KEY);
}

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let pickerLoaded = false;
let cachedEmail = null;

function waitFor(check, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('No se pudo cargar el inicio de sesión de Google. Revisa tu conexión.'));
        return;
      }
      setTimeout(poll, 100);
    })();
  });
}

function loadStoredToken() {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.expiresAt > Date.now()) {
      accessToken = data.accessToken;
      tokenExpiresAt = data.expiresAt;
    }
  } catch {
    // ignorar datos corruptos
  }
}

function storeToken(token, expiresInSec) {
  accessToken = token;
  tokenExpiresAt = Date.now() + expiresInSec * 1000 - 60000; // 1 min de margen
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ accessToken, expiresAt: tokenExpiresAt }));
}

export function isSignedIn() {
  loadStoredToken();
  return !!accessToken && tokenExpiresAt > Date.now();
}

async function ensureTokenClient() {
  await waitFor(() => window.google && window.google.accounts && window.google.accounts.oauth2);
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: () => {}, // se reemplaza en cada llamada a signIn()
    });
  }
  return tokenClient;
}

/**
 * Devuelve un access token válido, pidiendo inicio de sesión (con la
 * pantalla de Google) solo si no hay uno vigente guardado.
 */
export async function signIn() {
  loadStoredToken();
  if (accessToken && tokenExpiresAt > Date.now()) return accessToken;

  const client = await ensureTokenClient();
  return new Promise((resolve, reject) => {
    client.callback = (resp) => {
      if (resp.error) {
        reject(new Error(resp.error_description || resp.error));
        return;
      }
      storeToken(resp.access_token, resp.expires_in);
      resolve(accessToken);
    };
    client.requestAccessToken();
  });
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2?.revoke) {
    window.google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiresAt = 0;
  cachedEmail = null;
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

/**
 * Correo de la cuenta de Google con la que se inició sesión, o null si no
 * hay sesión activa. Se usa para saber si quien está usando la app es el
 * admin (Pancho) y por lo tanto puede ver la opción de cambiar la carpeta
 * raíz — cualquier otra persona la ve fija.
 */
export async function getSignedInEmail() {
  if (!isSignedIn()) return null;
  if (cachedEmail) return cachedEmail;
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    cachedEmail = data.email || null;
    return cachedEmail;
  } catch {
    return null;
  }
}

async function ensurePickerLoaded() {
  await waitFor(() => window.gapi);
  if (pickerLoaded) return;
  await new Promise((resolve, reject) => {
    window.gapi.load('picker', { callback: resolve, onerror: reject });
  });
  pickerLoaded = true;
}

/**
 * Abre el selector oficial de Google para elegir (o crear) una carpeta.
 * Si se pasa `parentId`, el selector queda restringido a navegar solo
 * dentro de esa carpeta (no se puede ver ni elegir nada fuera de ella).
 * Devuelve { id, name } de la carpeta elegida, o null si se cancela.
 */
export async function openFolderPicker(parentId) {
  const token = await signIn();
  await ensurePickerLoaded();

  return new Promise((resolve) => {
    const view = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
      .setSelectFolderEnabled(true)
      .setIncludeFolders(true)
      .setMode(window.google.picker.DocsViewMode.LIST);
    if (parentId) {
      view.setParent(parentId);
    }

    const picker = new window.google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .setTitle(parentId ? 'Elige la carpeta del proyecto' : 'Elige tu carpeta raíz de proyectos')
      .setCallback((data) => {
        if (data.action === window.google.picker.Action.PICKED) {
          const doc = data.docs[0];
          resolve({ id: doc.id, name: doc.name });
        } else if (data.action === window.google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}

/**
 * Lista las subcarpetas (no archivos) que ya existen dentro de una carpeta
 * de Drive. Se usa para reflejar en la app carpetas creadas directamente
 * en Drive (por Pancho u otra persona del proyecto).
 */
export async function listDriveFolders(parentId) {
  const token = await signIn();
  const q = encodeURIComponent(
    `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=200&spaces=drive`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Error listando carpetas de Drive (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.files || [];
}

/**
 * Crea una subcarpeta nueva dentro de una carpeta de Drive. Se usa cuando
 * Pancho crea una carpeta en la app dentro de una carpeta ya enlazada, para
 * que también quede creada del lado de Drive.
 */
export async function createDriveFolder(parentId, name) {
  const token = await signIn();
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Error creando carpeta en Drive (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Lista los archivos de imagen dentro de una carpeta de Drive (no
 * subcarpetas). Se usa para el selector de planos: Pancho convierte sus
 * planos de CAD a PNG/JPEG y los deja en la carpeta "Planos de obra" de
 * cada obra; acá se listan para elegir uno.
 */
export async function listDriveFiles(parentId) {
  const token = await signIn();
  const q = encodeURIComponent(`'${parentId}' in parents and mimeType contains 'image/' and trashed=false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&pageSize=200&spaces=drive`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Error listando archivos de Drive (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.files || [];
}

/**
 * Lista los archivos .csv dentro de una carpeta de Drive, más recientes
 * primero — se usa para traer la programación de obra que Pancho va
 * subiendo directo a Drive (carpeta Control/Obras/<obra>/Programación).
 * Se filtra por el nombre (no por mimeType): Drive guarda un .csv con
 * mimeType distinto según cómo se subió (text/csv, application/vnd.ms-excel,
 * text/plain…), así que el nombre es más confiable.
 */
export async function listDriveCsvFiles(parentId) {
  const token = await signIn();
  const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=200&spaces=drive&orderBy=modifiedTime desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Error listando archivos de Drive (${res.status}): ${text}`);
  }
  const data = await res.json();
  return (data.files || []).filter((f) => f.name.toLowerCase().endsWith('.csv'));
}

/**
 * Descarga el contenido de un archivo de Drive como Blob (para cachear
 * localmente el plano elegido, offline-first como el resto de la app).
 */
export async function downloadDriveFile(fileId) {
  const token = await signIn();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Error descargando archivo de Drive (${res.status}): ${text}`);
  }
  return res.blob();
}

/**
 * Busca una subcarpeta dentro de una carpeta de Drive comparando el nombre
 * sin importar mayúsculas/minúsculas ni espacios de más; si no existe, la
 * crea. Se usa para armar el árbol OBRAS/<obra>/PLANOS.../PROTOCOLOS
 * FIRMADOS sin duplicar carpetas si ya existían (ej. porque Pancho las armó
 * a mano de antemano). Antes esto comparaba el nombre EXACTO vía la query
 * de Drive (`name='...'`) y en la práctica no encontraba carpetas ya
 * existentes con la misma pinta (algún espacio o mayúscula distinta),
 * creando duplicados — por eso ahora se listan todas las subcarpetas y se
 * compara en el navegador, más tolerante.
 */
export async function findOrCreateDriveFolder(parentId, name) {
  let existing = [];
  try {
    existing = await listDriveFolders(parentId);
  } catch (err) {
    console.error('No se pudo listar subcarpetas de Drive antes de crear una nueva:', err);
  }
  const target = name.trim().toLowerCase();
  const match = existing.find((f) => f.name.trim().toLowerCase() === target);
  if (match) return match;
  return createDriveFolder(parentId, name);
}

/**
 * Sube un archivo a una carpeta de Drive. Lanza un error si falla (el
 * llamador decide qué hacer: reintentar más tarde, marcar como error, etc).
 */
export async function uploadFile(folderId, blob, filename) {
  const token = await signIn();
  const metadata = { name: filename, parents: [folderId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Error subiendo a Drive (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Lista los archivos .json dentro de una carpeta de Drive, más recientes
 * primero — se usa para sincronizar checklist/personal entre los teléfonos
 * de todo el equipo (cada guardado sube un .json nuevo a esta carpeta;
 * cada apertura de la app trae los que todavía no tenga).
 */
export async function listDriveJSONFiles(parentId) {
  const token = await signIn();
  const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=500&spaces=drive&orderBy=modifiedTime desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Error listando archivos de Drive (${res.status}): ${text}`);
  }
  const data = await res.json();
  return (data.files || []).filter((f) => f.name.toLowerCase().endsWith('.json'));
}

/**
 * Sube un objeto como archivo .json a una carpeta de Drive. Cada guardado
 * sube un archivo NUEVO (no reemplaza uno existente) — más simple que
 * mantener un id de archivo a actualizar, y el que sincroniza mira siempre
 * el más reciente por nombre.
 */
export async function uploadJSON(folderId, filename, data) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  return uploadFile(folderId, blob, filename);
}
