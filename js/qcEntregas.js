// Reglas de las entregas del módulo Control de calidad.
//
//  - Una entrega incompleta pasa a "Devuelta (incompleta)": no se revisa y su
//    plazo no corre. El plazo corre de nuevo con la versión nueva.
//  - El plazo de revisión se cuenta en días hábiles (con feriados de Chile)
//    desde la recepción de la entrega completa.
//  - No se puede recomendar ni aprobar una entrega con observaciones que, según
//    la regla de su categoría, la bloquean.
import { addBusinessDays, toISO } from './qcDates.js';

export const ESTADO_ENTREGA = {
  recibida: 'Recibida',
  devuelta: 'Devuelta (incompleta)',
  enRevision: 'En revisión',
  conObservaciones: 'Con observaciones',
  reentrega: 'Re-entrega recibida',
  recomendada: 'Recomendada para aprobación',
  aprobada: 'Aprobada',
};

// Estados en los que el plazo de revisión está corriendo.
const REVISANDO = [ESTADO_ENTREGA.recibida, ESTADO_ENTREGA.enRevision, ESTADO_ENTREGA.reentrega];

export const hoyISO = () => toISO(new Date());

export function ordenarEntregas(entregas) {
  return [...entregas].sort((a, b) => (a.fechaRecepcion || '').localeCompare(b.fechaRecepcion || '') || (a.createdAt || 0) - (b.createdAt || 0));
}

const esCompleta = (e) => e.completa !== false && e.estado !== ESTADO_ENTREGA.devuelta;

/** Fecha en que vence la revisión de una entrega, o null si no corre (incompleta o sin fecha). */
export function venceEntrega(entrega, etapa, holidays) {
  if (!esCompleta(entrega) || !entrega.fechaRecepcion) return null;
  return addBusinessDays(entrega.fechaRecepcion, etapa?.plazoRevisionDias || 10, holidays);
}

export function entregaVencida(entrega, etapa, holidays, hoy = hoyISO()) {
  const vence = venceEntrega(entrega, etapa, holidays);
  return !!vence && REVISANDO.includes(entrega.estado) && hoy > vence;
}

/**
 * Etapa con las fechas reales de sus entregas. La fecha de recepción que usan
 * las actividades es la de la PRIMERA entrega completa (la devuelta no cuenta);
 * "re-entrega" es la recepción de la segunda completa; "informe" es la fecha
 * del informe de revisión. Si todavía no hay entregas se usa la recepción
 * prevista que se puso a mano en el plan.
 */
export function etapaEfectiva(etapa, entregasDeLaEtapa) {
  const completas = ordenarEntregas(entregasDeLaEtapa.filter(esCompleta));
  const primera = completas[0];
  return {
    ...etapa,
    fechaRecepcion: primera?.fechaRecepcion || etapa.fechaRecepcion || null,
    fechaRecepcionReal: !!primera?.fechaRecepcion,
    fechaInforme: completas.find((e) => e.fechaInforme)?.fechaInforme || null,
    fechaReentrega: completas[1]?.fechaRecepcion || null,
  };
}

/**
 * Observaciones que impiden recomendar o aprobar una entrega, según la regla de
 * su categoría en el catálogo:
 *  - 'abiertas': bloquea mientras no esté cerrada.
 *  - 'sin_solucion': bloquea hasta que esté cerrada o tenga solución acordada.
 *  - 'no': nunca bloquea.
 */
export function observacionesBloqueantes(data, entregaId) {
  const categorias = data.catalogos.categorias || [];
  return (data.observaciones || []).filter((o) => {
    if (o.anulado || o.entregaId !== entregaId || o.estado === 'Cerrada') return false;
    const regla = categorias.find((c) => c.codigo === o.categoria)?.bloquea || 'no';
    if (regla === 'abiertas') return true;
    if (regla === 'sin_solucion') return !o.solucionAcordada;
    return false;
  });
}
