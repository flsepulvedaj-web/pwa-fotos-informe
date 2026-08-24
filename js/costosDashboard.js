// KPI del módulo Costos — mismo espíritu que controlDashboard.js: funciones
// puras que reciben los datos ya cargados de db.js y devuelven números
// listos para pintar. Todo se calcula desde los registros crudos (nunca se
// guarda un "acumulado" aparte) para que no haya forma de que quede
// desincronizado con la lista real.
import { costosMontoTotal, costosFacturaMontoNeto } from './db.js';

/**
 * Presupuesto vigente = presupuesto oficial del contrato + la suma de las
 * modificaciones ya aprobadas (las pendientes o rechazadas no suman).
 */
export function computePresupuestoVigente(contrato, modificaciones) {
  const oficial = contrato?.presupuestoOficial || 0;
  const aprobadas = modificaciones
    .filter((m) => m.estado === 'aprobada')
    .reduce((sum, m) => sum + costosMontoTotal(m.montoAprobado), 0);
  return oficial + aprobadas;
}

/** Total facturado acumulado (contractual + modificaciones, todas las facturas). */
export function computeTotalFacturado(facturas) {
  return facturas.reduce((sum, f) => sum + costosFacturaMontoNeto(f), 0);
}

/** % de avance financiero = facturado acumulado / presupuesto vigente. */
export function computeAvanceFinancieroPercent(totalFacturado, presupuestoVigente) {
  if (!presupuestoVigente) return null;
  return Math.round((totalFacturado / presupuestoVigente) * 1000) / 10;
}

/** Modificaciones sin resolver: cantidad + monto presentado (lo que se
 * está esperando que Enex apruebe o rechace). */
export function computeModificacionesPendientes(modificaciones) {
  const pendientes = modificaciones.filter((m) => m.estado === 'pendiente');
  return {
    cantidad: pendientes.length,
    monto: pendientes.reduce((sum, m) => sum + costosMontoTotal(m.montoPresentado), 0),
  };
}

/** Reembolsos sin pagar: cantidad + monto con IVA (lo que falta que le paguen a Pancho). */
export function computeReembolsosPendientes(reembolsos) {
  const pendientes = reembolsos.filter((r) => !r.fechaPago);
  return {
    cantidad: pendientes.length,
    monto: pendientes.reduce((sum, r) => sum + (r.montoConIva || 0), 0),
  };
}

/** Formato de plata simple, sin librería — miles con punto (formato chileno). */
export function formatMonto(n, moneda = '$') {
  const rounded = Math.round(n || 0);
  return `${moneda}${rounded.toLocaleString('es-CL')}`;
}
