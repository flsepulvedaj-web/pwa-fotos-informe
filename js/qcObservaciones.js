// Reglas de las observaciones del módulo Control de calidad (sin pantalla):
// estados, quién puede hacer qué según su rol, numeración y fotos adjuntas.
//
//  - Estados: Abierta → Respondida → En verificación → Cerrada.
//  - Solo el revisor (o el responsable del proyecto / un administrador) cierra una
//    observación. El revisado responde y adjunta la corrección, pero no la cierra.
//  - Una observación nunca se borra: se anula con un motivo.
import { downscaleImageBlob, blobToDataURL } from './utils.js';

export const ESTADO_OBS = {
  abierta: 'Abierta',
  respondida: 'Respondida',
  verificacion: 'En verificación',
  cerrada: 'Cerrada',
};
export const ORDEN_ESTADOS_OBS = [ESTADO_OBS.abierta, ESTADO_OBS.respondida, ESTADO_OBS.verificacion, ESTADO_OBS.cerrada];

export const MAX_ADJUNTOS = 4;

/**
 * Qué puede hacer una persona con las observaciones del proyecto.
 *  - `rol`: el rol de su ficha de participante (null si no está en la lista).
 *  - `admin`: administrador de la cuenta (puede todo).
 */
export function permisosObservaciones(rol, admin) {
  const gestor = admin || rol === 'responsable' || rol === 'revisor';
  return {
    crear: gestor || rol === 'asesor',
    editar: gestor,
    responder: admin || rol === 'revisado',
    cerrar: gestor,
    reabrir: gestor,
    anular: admin || rol === 'responsable',
    soloLectura: !(gestor || rol === 'asesor' || rol === 'revisado'),
  };
}

/** Siguiente número correlativo de observación del proyecto. */
export function siguienteNumero(observaciones) {
  return observaciones.reduce((max, o) => Math.max(max, Number(o.numero) || 0), 0) + 1;
}

/**
 * Dos personas pueden crear observaciones sin conexión y quedar con el mismo N°.
 * Esto calcula —igual en todos los aparatos— qué observaciones deben cambiar de
 * número: la más antigua (por fecha de creación, luego por id) conserva el suyo y
 * las demás pasan a los números siguientes al mayor. Devuelve
 * [{ id, numero, numeroOriginal }]; vacío si no hay repetidos.
 */
export function numerosARenumerar(observaciones) {
  const vivas = observaciones.filter((o) => !o.anulado || o.numero != null);
  const porNumero = new Map();
  for (const o of vivas) {
    const n = Number(o.numero) || 0;
    if (!porNumero.has(n)) porNumero.set(n, []);
    porNumero.get(n).push(o);
  }
  const cmp = (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id));
  const perdedoras = [];
  for (const grupo of porNumero.values()) {
    if (grupo.length < 2) continue;
    grupo.sort(cmp);
    perdedoras.push(...grupo.slice(1));
  }
  if (!perdedoras.length) return [];
  perdedoras.sort(cmp);
  let siguiente = vivas.reduce((max, o) => Math.max(max, Number(o.numero) || 0), 0) + 1;
  return perdedoras.map((o) => ({ id: o.id, numero: siguiente++, numeroOriginal: Number(o.numero) || null }));
}

/** Reduce una foto a un tamaño liviano y la devuelve como adjunto listo para guardar en el evento. */
export async function fotoComoAdjunto(file) {
  const blob = await downscaleImageBlob(file, 1280, 0.7);
  const data = await blobToDataURL(blob);
  return { id: crypto.randomUUID(), nombre: file.name || 'foto.jpg', tipo: 'image/jpeg', data };
}

/** Color y texto de la categoría según el catálogo del proyecto. */
export function categoriaInfo(catalogos, codigo) {
  const c = (catalogos.categorias || []).find((x) => x.codigo === codigo);
  return { codigo, nombre: c?.nombre || '', bloquea: c?.bloquea || 'no' };
}

export const nombreItem = (x) => (typeof x === 'string' ? x : x?.nombre || '');
