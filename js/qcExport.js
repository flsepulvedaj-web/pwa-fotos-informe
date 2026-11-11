// Exportación del módulo Control de calidad a Excel (usa la librería SheetJS que
// ya trae la app en vendor/xlsx.full.min.js, cargada como `XLSX` global).
import { downloadBlob, sanitizeFilename } from './pdfExport.js';
import { ordenarEntregas, venceEntrega, ESTADO_ENTREGA } from './qcEntregas.js';
import { TIPO_CERT, ACCION_CERT } from './qcFirma.js';
import { ORDEN_ESTADOS_OBS } from './qcObservaciones.js';

const fecha = (iso) => (iso ? String(iso).split('-').reverse().join('-') : '');
const fechaHora = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

function hojaDesdeFilas(XLSX, filas, columnas) {
  const ws = XLSX.utils.json_to_sheet(filas, { header: columnas.map((c) => c.titulo) });
  ws['!cols'] = columnas.map((c) => ({ wch: c.ancho }));
  if (ws['!ref']) ws['!autofilter'] = { ref: ws['!ref'] };
  return ws;
}

/**
 * Arma el libro de Excel del proyecto. `nombreDe(correo)` devuelve el nombre de
 * la persona para mostrarlo en vez del correo. Devuelve el libro (no lo descarga).
 */
export function construirLibro(XLSX, data, nombreDe, feriados = []) {
  const quien = (c) => (c ? nombreDe(c) : '');
  const etapas = data.etapas.filter((e) => !e.anulado);
  const etapaDe = (id) => etapas.find((e) => e.id === id);
  const entregas = ordenarEntregas(data.entregas.filter((e) => !e.anulado));
  const etiquetaEntrega = (id) => {
    const e = data.entregas.find((x) => x.id === id);
    if (!e) return '';
    const et = etapaDe(e.etapaId);
    return `${et ? 'Etapa ' + et.codigo + ' · ' : ''}${e.version || ''}`;
  };
  const obs = data.observaciones.filter((o) => !o.anulado).sort((a, b) => (Number(a.numero) || 0) - (Number(b.numero) || 0));
  const anuladas = data.observaciones.filter((o) => o.anulado).sort((a, b) => (Number(a.numero) || 0) - (Number(b.numero) || 0));

  const colsObs = [
    { titulo: 'N°', ancho: 6, v: (o) => Number(o.numero) || '' },
    { titulo: 'Entrega', ancho: 18, v: (o) => etiquetaEntrega(o.entregaId) },
    { titulo: 'Especialidad', ancho: 18, v: (o) => o.especialidad || '' },
    { titulo: 'Categoría', ancho: 10, v: (o) => o.categoria || '' },
    { titulo: 'Documento o plano', ancho: 20, v: (o) => o.documento || '' },
    { titulo: 'Observación', ancho: 70, v: (o) => o.texto || '' },
    { titulo: 'Requisito o referencia', ancho: 26, v: (o) => o.referencia || '' },
    { titulo: 'Estado', ancho: 15, v: (o) => o.estado || '' },
    { titulo: 'Fecha de creación', ancho: 14, v: (o) => fecha(o.fechaCreacion) },
    { titulo: 'Creada por', ancho: 24, v: (o) => quien(o.creadaPor) },
    { titulo: 'Respuesta del revisado', ancho: 60, v: (o) => o.respuesta || '' },
    { titulo: 'Fecha de respuesta', ancho: 14, v: (o) => fecha(o.fechaRespuesta) },
    { titulo: 'Respondida por', ancho: 24, v: (o) => quien(o.respondidaPor) },
    { titulo: 'Solución acordada', ancho: 12, v: (o) => (o.solucionAcordada ? 'Sí' : '') },
    { titulo: 'Fecha de cierre', ancho: 14, v: (o) => fecha(o.fechaCierre) },
    { titulo: 'Verificada por', ancho: 24, v: (o) => quien(o.verificadaPor) },
    { titulo: 'Fotos', ancho: 7, v: (o) => (o.adjuntos || []).length + (o.adjuntosRespuesta || []).length || '' },
  ];
  const filasObs = (lista, extra) =>
    lista.map((o) => {
      const fila = Object.fromEntries(colsObs.map((c) => [c.titulo, c.v(o)]));
      return extra ? { ...fila, ...extra(o) } : fila;
    });

  const wb = XLSX.utils.book_new();

  // 1) Resumen
  const cats = data.catalogos.categorias || [];
  const abiertas = obs.filter((o) => o.estado !== 'Cerrada');
  const resumen = [
    [data.proyecto?.nombre || 'Proyecto'],
    ['Matriz de observaciones · generada el ' + fecha(new Date().toISOString().slice(0, 10))],
    [],
    ['Categoría', ...ORDEN_ESTADOS_OBS, 'Total'],
    ...cats.map((c) => {
      const lista = obs.filter((o) => o.categoria === c.codigo);
      return [`${c.codigo} · ${c.nombre}`, ...ORDEN_ESTADOS_OBS.map((e) => lista.filter((o) => o.estado === e).length), lista.length];
    }),
    ['Total', ...ORDEN_ESTADOS_OBS.map((e) => obs.filter((o) => o.estado === e).length), obs.length],
    [],
    ['Observaciones abiertas (no cerradas)', abiertas.length],
    ['Observaciones anuladas', anuladas.length],
  ];
  const wsRes = XLSX.utils.aoa_to_sheet(resumen);
  wsRes['!cols'] = [{ wch: 38 }, ...ORDEN_ESTADOS_OBS.map(() => { return { wch: 16 }; }), { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsRes, 'Resumen');

  // 2) Matriz de observaciones
  XLSX.utils.book_append_sheet(wb, hojaDesdeFilas(XLSX, filasObs(obs), colsObs), 'Observaciones');

  // 3) Entregas
  const colsEnt = [
    { titulo: 'Etapa', ancho: 34 },
    { titulo: 'Versión', ancho: 9 },
    { titulo: 'Fecha de recepción', ancho: 16 },
    { titulo: 'Completa', ancho: 10 },
    { titulo: 'Estado', ancho: 26 },
    { titulo: 'Revisión vence', ancho: 15 },
    { titulo: 'Informe de revisión', ancho: 18 },
    { titulo: 'Observaciones abiertas', ancho: 14 },
    { titulo: 'Aprobación (1ª firma)', ancho: 24 },
    { titulo: 'Aprobación (2ª firma)', ancho: 24 },
    { titulo: 'Fecha de aprobación', ancho: 16 },
  ];
  const filasEnt = entregas.map((e) => {
    const et = etapaDe(e.etapaId);
    return {
      Etapa: et ? `${et.codigo} · ${et.nombre}` : '',
      Versión: e.version || '',
      'Fecha de recepción': fecha(e.fechaRecepcion),
      Completa: e.completa === false || e.estado === ESTADO_ENTREGA.devuelta ? 'No' : 'Sí',
      Estado: e.estado || '',
      'Revisión vence': fecha(venceEntrega(e, et, feriados)),
      'Informe de revisión': fecha(e.fechaInforme),
      'Observaciones abiertas': obs.filter((o) => o.entregaId === e.id && o.estado !== 'Cerrada').length,
      'Aprobación (1ª firma)': quien(e.aprobacion1Por),
      'Aprobación (2ª firma)': quien(e.aprobacion2Por),
      'Fecha de aprobación': fecha(e.fechaAprobacion),
    };
  });
  XLSX.utils.book_append_sheet(wb, hojaDesdeFilas(XLSX, filasEnt, colsEnt), 'Entregas');

  // 4) Certificaciones
  const colsCert = [
    { titulo: 'Fecha y hora', ancho: 18 },
    { titulo: 'Qué se certificó', ancho: 34 },
    { titulo: 'Firmó', ancho: 26 },
    { titulo: 'Cargo', ancho: 22 },
    { titulo: 'Cuenta', ancho: 28 },
    { titulo: 'Firma', ancho: 12 },
    { titulo: 'Comentario', ancho: 40 },
    { titulo: 'Estado', ancho: 12 },
    { titulo: 'Motivo de anulación', ancho: 34 },
    { titulo: 'Huella', ancho: 20 },
  ];
  const certs = [...data.certificaciones].sort((a, b) => String(a.fechaHora || '').localeCompare(String(b.fechaHora || '')));
  const filasCert = certs.map((c) => ({
    'Fecha y hora': fechaHora(c.fechaHora),
    'Qué se certificó': `${TIPO_CERT[c.tipo] || c.tipo} ${c.refCodigo || ''} · ${ACCION_CERT[c.accion] || c.accion}`,
    Firmó: c.firmanteNombre || '',
    Cargo: c.firmanteCargo || '',
    Cuenta: c.firmadoPor || '',
    Firma: c.nivel === 2 ? 'Segunda' : 'Primera',
    Comentario: c.comentario || '',
    Estado: c.anulado ? 'Anulada' : 'Vigente',
    'Motivo de anulación': c.motivoAnulacion || '',
    Huella: String(c.huella || '').slice(0, 16),
  }));
  XLSX.utils.book_append_sheet(wb, hojaDesdeFilas(XLSX, filasCert, colsCert), 'Certificaciones');

  // 5) Anuladas (solo si hay)
  if (anuladas.length) {
    const extra = (o) => ({ 'Motivo de anulación': o.motivoAnulacion || '' });
    XLSX.utils.book_append_sheet(wb, hojaDesdeFilas(XLSX, filasObs(anuladas, extra), [...colsObs, { titulo: 'Motivo de anulación', ancho: 40 }]), 'Anuladas');
  }
  return wb;
}

/** Genera el Excel del proyecto y lo descarga. */
export function exportarExcel(data, nombreDe) {
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('No se cargó la librería de Excel.');
  const feriados = (data.catalogos.feriados || []).map((h) => h.fecha);
  const wb = construirLibro(XLSX, data, nombreDe, feriados);
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const hoy = new Date().toISOString().slice(0, 10);
  const nombre = `Matriz de observaciones - ${sanitizeFilename(data.proyecto?.nombre || 'proyecto').slice(0, 60)} - ${hoy}.xlsx`;
  downloadBlob(blob, nombre);
  return nombre;
}
