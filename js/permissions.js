// Permisos por módulo, por usuario (correo de Google). El admin decide qué
// módulos ve cada persona del equipo; se guarda en un único archivo
// compartido en Drive (permissions.json, dentro de la carpeta raíz por
// defecto que ya usa todo el equipo — así nadie necesita que le compartan
// una carpeta nueva aparte para esto) y se cachea localmente para que siga
// funcionando sin internet una vez que se cargó la primera vez.
import { DEFAULT_ROOT_FOLDER, findFileByName, updateFileContent, uploadFile, downloadDriveFile } from './googleDrive.js';

// Admins: ven todos los módulos siempre y pueden editar los permisos del
// resto desde /usuarios.
export const ADMIN_EMAILS = ['flsepulvedaj@gmail.com', 'jzruiz5@gmail.com'];

// Estos son los módulos con acceso real (los que se pueden tildar en
// /usuarios) — "Banco" y "Proyectos" en el Home son solo agrupadores
// visuales de estos mismos módulos + placeholders "Próximamente" sin
// permiso propio todavía (ver bancoHomeView.js / proyectosHomeView.js).
export const APP_MODULES = [
  { id: 'fotos', title: 'Avance de obra', desc: 'Fotos de obra → informe PDF' },
  { id: 'protocolos', title: 'Protocolos', desc: 'Checklist de calidad + firma digital' },
  { id: 'control', title: 'Control', desc: 'Programación, SSMA, actas y KPI de obra' },
  // Permiso propio y separado de Control a propósito: es información
  // sensible (plata del contrato) — no todo el que ve Control (ej. el ITO
  // en terreno) debería ver esto también.
  { id: 'costos', title: 'Costos', desc: 'Presupuesto, modificaciones, facturación y reembolsos' },
  // RDI también permiso propio, pero por otra razón: no es plata, es que
  // puede tener sentido dárselo a alguien en terreno (quien redacta el RDI)
  // sin necesariamente darle todo Control.
  { id: 'rdi', title: 'RDI', desc: 'Requerimientos de información al mandante y tiempos de respuesta' },
];

const CACHE_KEY = 'control-permissions-cache-v1';
const FILE_NAME = 'permissions.json';

export function isAdmin(email) {
  return !!email && ADMIN_EMAILS.includes(email);
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveCache(data) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(data));
}

/**
 * Trae los permisos de Drive y actualiza la caché local. Si falla (sin
 * internet, primera vez, etc.), devuelve lo último que había en caché —
 * nunca lanza error, para que la app siga funcionando offline.
 */
export async function fetchPermissions() {
  try {
    const file = await findFileByName(DEFAULT_ROOT_FOLDER.id, FILE_NAME);
    if (!file) {
      saveCache({});
      return {};
    }
    const blob = await downloadDriveFile(file.id);
    const data = JSON.parse(await blob.text());
    saveCache(data);
    return data;
  } catch (err) {
    console.error('No se pudieron traer los permisos de Drive, usando caché local:', err);
    return loadCache();
  }
}

/** Permisos ya cacheados localmente, sin tocar la red — para el arranque
 * offline o mientras se resuelve fetchPermissions(). */
export function getCachedPermissions() {
  return loadCache();
}

/** Módulos que puede ver un correo: todos si es admin, si no los que
 * tenga asignados en el objeto de permisos (o ninguno si no está listado). */
export function modulesForEmail(email, permissions) {
  if (isAdmin(email)) return APP_MODULES.map((m) => m.id);
  return permissions?.[email]?.modules || [];
}

/** Guarda el objeto de permisos completo en Drive (solo admin debería
 * llamar esto — la pantalla de administración ya restringe el acceso). */
export async function savePermissions(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const existing = await findFileByName(DEFAULT_ROOT_FOLDER.id, FILE_NAME);
  if (existing) {
    await updateFileContent(existing.id, blob);
  } else {
    await uploadFile(DEFAULT_ROOT_FOLDER.id, blob, FILE_NAME);
  }
  saveCache(data);
}
