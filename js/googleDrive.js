// Integración con Google Drive: login (Google Identity Services), selector
// de carpeta (Picker API) y subida de archivos (Drive API v3).
// Scope drive.file: la app solo puede tocar archivos/carpetas que el propio
// usuario le autorice explícitamente a través del selector oficial de
// Google — nunca el resto de su Drive.

const CLIENT_ID = '1005265173127-i5lhpkpnmi8mlraev3hvla9p2qrf2v11.apps.googleusercontent.com';
const API_KEY = 'AIzaSyBPOsLlvyl1bPtQxURmf4V-C7pUvLxZl04';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_STORAGE_KEY = 'gdrive-token';

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let pickerLoaded = false;

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
  localStorage.removeItem(TOKEN_STORAGE_KEY);
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
 * Devuelve { id, name } de la carpeta elegida, o null si se cancela.
 */
export async function openFolderPicker() {
  const token = await signIn();
  await ensurePickerLoaded();

  return new Promise((resolve) => {
    const view = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
      .setSelectFolderEnabled(true)
      .setIncludeFolders(true)
      .setMode(window.google.picker.DocsViewMode.LIST);

    const picker = new window.google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .setTitle('Elige la carpeta de tu proyecto')
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
 * Sube un archivo a una carpeta de Drive. Lanza un error si falla (el
 * llamador decide qué hacer: reintentar más tarde, marcar como error, etc).
 */
export async function uploadFile(folderId, blob, filename) {
  const token = await signIn();
  const metadata = { name: filename, parents: [folderId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
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
