// Firma de certificación del módulo Control de calidad (sin pantalla).
//
// Cada persona crea una vez su PIN y su firma dibujada. Para certificar algo
// (terminar una actividad, cerrar una observación, aprobar una entrega) tiene
// que estar con su sesión de Google, poner su PIN y queda un registro con su
// nombre, fecha y hora, su firma dibujada y una huella de lo que firmó.
//
// El PIN se guarda "revuelto" (PBKDF2-SHA-256 con sal propia), nunca en claro.
// Aviso honesto: el PIN protege contra quien tenga el teléfono o el computador
// abierto con la sesión de otra persona; no es una firma electrónica avanzada
// con valor legal. Las certificaciones se guardan en el historial encadenado,
// donde cualquier alteración se detecta, y no se pueden borrar (solo anular).
import { downscaleImageBlob, blobToDataURL } from './utils.js';

const ITERACIONES = 150000;
const MAX_FALLOS = 5;
const BLOQUEO_MS = 5 * 60 * 1000;

const aHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const aB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const deB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Id del registro de PIN de una persona: su correo en minúsculas. */
export const idPin = (correo) => String(correo || '').trim().toLowerCase();

export const pinValido = (pin) => /^\d{4,6}$/.test(String(pin || ''));

async function derivar(pin, salBytes, iter) {
  const clave = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salBytes, iterations: iter }, clave, 256);
  return aHex(bits);
}

/** Datos a guardar en la tabla `pines` para un PIN nuevo (más la firma dibujada ya reducida). */
export async function crearRegistroPin(correo, pin, firmaDibujada) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  return { correo: idPin(correo), sal: aB64(sal), iter: ITERACIONES, hash: await derivar(pin, sal, ITERACIONES), firmaDibujada, creadoEn: Date.now(), reiniciado: false };
}

export const tienePin = (registro) => !!(registro && registro.hash && registro.sal);

export async function verificarPin(registro, pin) {
  if (!tienePin(registro) || !pinValido(pin)) return false;
  return (await derivar(pin, deB64(registro.sal), registro.iter || ITERACIONES)) === registro.hash;
}

// ---- Bloqueo tras intentos fallidos (por aparato) ----
const claveFallos = (correo) => `qc-pin-fallos-${idPin(correo)}`;

export function estadoBloqueo(correo) {
  try {
    const f = JSON.parse(localStorage.getItem(claveFallos(correo)) || 'null');
    if (!f) return { bloqueado: false, restantes: MAX_FALLOS };
    if (f.hasta && f.hasta > Date.now()) return { bloqueado: true, hasta: f.hasta, restantes: 0 };
    if (f.hasta && f.hasta <= Date.now()) {
      localStorage.removeItem(claveFallos(correo));
      return { bloqueado: false, restantes: MAX_FALLOS };
    }
    return { bloqueado: false, restantes: Math.max(0, MAX_FALLOS - (f.n || 0)) };
  } catch {
    return { bloqueado: false, restantes: MAX_FALLOS };
  }
}

export function registrarFallo(correo) {
  try {
    const f = JSON.parse(localStorage.getItem(claveFallos(correo)) || '{"n":0}');
    const n = (f.n || 0) + 1;
    localStorage.setItem(claveFallos(correo), JSON.stringify(n >= MAX_FALLOS ? { n, hasta: Date.now() + BLOQUEO_MS } : { n }));
  } catch {
    /* sin almacenamiento: no hay bloqueo local */
  }
}

export function limpiarFallos(correo) {
  try {
    localStorage.removeItem(claveFallos(correo));
  } catch {
    /* nada */
  }
}

/** Firma dibujada (blob del pad) reducida a un JPEG liviano para guardar y mostrar. */
export async function firmaComoDataURL(blob) {
  return blobToDataURL(await downscaleImageBlob(blob, 480, 0.8));
}

// ---- Huella de lo firmado ----
function ordenado(v) {
  if (Array.isArray(v)) return v.map(ordenado);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordenado(v[k])]));
  return v;
}

export async function huellaDe(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(ordenado(obj)));
  return aHex(await crypto.subtle.digest('SHA-256', bytes));
}

/** Los datos de un registro que "se firman": lo que cambiarlo después alteraría lo certificado. */
export function contenidoFirmado(tipo, registro) {
  if (!registro) return {};
  if (tipo === 'actividad') return { codigo: registro.codigo, descripcion: registro.descripcion, responsableTexto: registro.responsableTexto, plazoTexto: registro.plazoTexto };
  if (tipo === 'observacion') return { numero: registro.numero, texto: registro.texto, categoria: registro.categoria, entregaId: registro.entregaId, respuesta: registro.respuesta || '', fotos: (registro.adjuntos || []).map((a) => a.id) };
  if (tipo === 'entrega') return { version: registro.version, etapaId: registro.etapaId, fechaRecepcion: registro.fechaRecepcion, completa: registro.completa };
  return {};
}

export const TIPO_CERT = {
  actividad: 'Actividad',
  observacion: 'Observación',
  entrega: 'Entrega',
};

export const ACCION_CERT = {
  terminada: 'terminada',
  cerrada: 'cerrada',
  recomendada: 'recomendada para aprobación',
  aprobada: 'aprobada',
};
