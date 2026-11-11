// Informe de revisión de una entrega, en PDF (jsPDF, A4 en mm, mismo patrón que
// los otros PDF de la app): datos de la entrega, resumen de observaciones por
// categoría y estado, cada observación con su respuesta, fotos y cierre, y las
// firmas de la aprobación.
import { venceEntrega } from './qcEntregas.js';
import { TIPO_CERT, ACCION_CERT } from './qcFirma.js';
import { ORDEN_ESTADOS_OBS } from './qcObservaciones.js';

const MARGEN = 15;
const ANCHO = 210 - MARGEN * 2;
const COLOR_CAT = { A: [185, 28, 28], B: [180, 83, 9], C: [67, 56, 202] };

const fecha = (iso) => (iso ? String(iso).split('-').reverse().join('-') : '');
const fechaHora = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const imagenSegura = (d) => (typeof d === 'string' && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(d) ? d : '');
const formato = (d) => (d.startsWith('data:image/png') ? 'PNG' : 'JPEG');

/**
 * Devuelve el PDF (Blob) del informe de revisión de la entrega `entregaId`.
 * `nombreDe(correo)` devuelve el nombre de la persona.
 */
export function construirInformePDF(data, entregaId, nombreDe, feriados = []) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const entrega = data.entregas.find((e) => e.id === entregaId);
  const etapa = data.etapas.find((e) => e.id === entrega?.etapaId);
  const p = data.proyecto || {};
  const obs = data.observaciones.filter((o) => !o.anulado && o.entregaId === entregaId).sort((a, b) => (Number(a.numero) || 0) - (Number(b.numero) || 0));
  const categorias = data.catalogos.categorias || [];
  const quien = (c) => (c ? nombreDe(c) : '');
  let y = MARGEN;

  const ensure = (alto) => {
    if (y + alto > 297 - 18) {
      doc.addPage();
      y = MARGEN;
    }
  };
  const texto = (t, { size = 10, bold = false, color = [30, 30, 30], x = MARGEN, ancho = ANCHO, salto = 1.2 } = {}) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lineas = doc.splitTextToSize(String(t ?? ''), ancho);
    const alto = lineas.length * size * 0.3528 * salto;
    ensure(alto);
    doc.text(lineas, x, y + size * 0.3528);
    y += alto;
  };

  // Encabezado
  doc.setFillColor(30, 42, 90);
  doc.rect(0, 0, 210, 30, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.text('INFORME DE REVISION', MARGEN, 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(doc.splitTextToSize(p.nombre || 'Proyecto', ANCHO)[0], MARGEN, 22);
  y = 38;

  // Datos de la entrega
  const filas = [
    ['Mandante', p.mandante],
    ['Contrato', p.contrato || p.codigo],
    ['Etapa', etapa ? `${etapa.codigo} - ${etapa.nombre}` : ''],
    ['Entrega', entrega?.version],
    ['Fecha de recepcion', fecha(entrega?.fechaRecepcion)],
    ['Revision vence', fecha(venceEntrega(entrega, etapa, feriados))],
    ['Fecha del informe', fecha(entrega?.fechaInforme) || fecha(new Date().toISOString().slice(0, 10))],
    ['Estado de la entrega', entrega?.estado],
  ].filter(([, v]) => v);
  for (const [k, v] of filas) {
    ensure(6);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(90, 90, 90);
    doc.text(k, MARGEN, y + 3.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(30, 30, 30);
    doc.text(doc.splitTextToSize(String(v), ANCHO - 48)[0], MARGEN + 48, y + 3.5);
    y += 6;
  }
  y += 4;

  // Resumen
  texto('Resumen de observaciones', { size: 13, bold: true, color: [30, 42, 90] });
  y += 1;
  const colX = [MARGEN, MARGEN + 52, ...ORDEN_ESTADOS_OBS.map((_, i) => MARGEN + 52 + 26 * (i + 1))];
  ensure(8 + (categorias.length + 1) * 6);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(90, 90, 90);
  doc.text('Categoria', colX[0], y + 3.5);
  ORDEN_ESTADOS_OBS.forEach((e, i) => doc.text(e, colX[i + 1], y + 3.5));
  doc.text('Total', colX[ORDEN_ESTADOS_OBS.length + 1], y + 3.5);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(30, 30, 30);
  for (const c of categorias) {
    const lista = obs.filter((o) => o.categoria === c.codigo);
    doc.text(`${c.codigo} - ${c.nombre}`, colX[0], y + 3.5);
    ORDEN_ESTADOS_OBS.forEach((e, i) => doc.text(String(lista.filter((o) => o.estado === e).length), colX[i + 1], y + 3.5));
    doc.text(String(lista.length), colX[ORDEN_ESTADOS_OBS.length + 1], y + 3.5);
    y += 6;
  }
  doc.setFont('helvetica', 'bold');
  doc.text('Total', colX[0], y + 3.5);
  ORDEN_ESTADOS_OBS.forEach((e, i) => doc.text(String(obs.filter((o) => o.estado === e).length), colX[i + 1], y + 3.5));
  doc.text(String(obs.length), colX[ORDEN_ESTADOS_OBS.length + 1], y + 3.5);
  y += 10;

  // Observaciones
  texto('Observaciones', { size: 13, bold: true, color: [30, 42, 90] });
  y += 1;
  if (!obs.length) texto('Esta entrega no tiene observaciones registradas.', { color: [90, 90, 90] });
  for (const o of obs) {
    ensure(26);
    const color = COLOR_CAT[o.categoria] || [90, 90, 90];
    doc.setFillColor(...color);
    doc.roundedRect(MARGEN, y, 9, 5, 1, 1, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(o.categoria || '?', MARGEN + 4.5, y + 3.6, { align: 'center' });
    doc.setTextColor(30, 30, 30);
    doc.setFontSize(10);
    const cab = [`N° ${o.numero ?? '?'}`, o.especialidad, o.documento, o.estado].filter(Boolean).join('  |  ');
    doc.text(doc.splitTextToSize(cab, ANCHO - 12)[0], MARGEN + 12, y + 3.8);
    y += 7;
    texto(o.texto, { x: MARGEN + 2, ancho: ANCHO - 2 });
    if (o.referencia) texto(`Referencia: ${o.referencia}`, { size: 9, color: [90, 90, 90], x: MARGEN + 2, ancho: ANCHO - 2 });
    // Fotos de la observación
    const fotos = (o.adjuntos || []).map((a) => imagenSegura(a.data)).filter(Boolean).slice(0, 4);
    if (fotos.length) {
      y += 1.5;
      ensure(34);
      let x = MARGEN + 2;
      for (const f of fotos) {
        try {
          const pr = doc.getImageProperties(f);
          const h = 30;
          const w = Math.min(60, (pr.width / pr.height) * h);
          doc.addImage(f, formato(f), x, y, w, h);
          x += w + 3;
        } catch {
          /* foto ilegible: se omite */
        }
      }
      y += 33;
    }
    if (o.respuesta || (o.adjuntosRespuesta || []).length) {
      texto(`Respuesta${o.fechaRespuesta ? ' (' + fecha(o.fechaRespuesta) + (o.respondidaPor ? ', ' + quien(o.respondidaPor) : '') + ')' : ''}:`, { size: 9, bold: true, color: [60, 60, 60], x: MARGEN + 6, ancho: ANCHO - 6 });
      if (o.respuesta) texto(o.respuesta, { size: 9.5, x: MARGEN + 6, ancho: ANCHO - 6 });
      const fr = (o.adjuntosRespuesta || []).map((a) => imagenSegura(a.data)).filter(Boolean).slice(0, 4);
      if (fr.length) {
        y += 1.5;
        ensure(26);
        let x = MARGEN + 6;
        for (const f of fr) {
          try {
            const pr = doc.getImageProperties(f);
            const h = 24;
            const w = Math.min(50, (pr.width / pr.height) * h);
            doc.addImage(f, formato(f), x, y, w, h);
            x += w + 3;
          } catch {
            /* se omite */
          }
        }
        y += 27;
      }
    }
    if (o.estado === 'Cerrada') texto(`Cerrada el ${fecha(o.fechaCierre)}${o.verificadaPor ? ' - verificada por ' + quien(o.verificadaPor) : ''}`, { size: 9, color: [22, 101, 52], x: MARGEN + 6, ancho: ANCHO - 6 });
    y += 3;
    doc.setDrawColor(220, 220, 220);
    doc.line(MARGEN, y, MARGEN + ANCHO, y);
    y += 4;
  }

  // Firmas
  const certs = data.certificaciones
    .filter((c) => !c.anulado && ((c.refTabla === 'entregas' && c.refId === entregaId) || (c.refTabla === 'observaciones' && obs.some((o) => o.id === c.refId))))
    .sort((a, b) => String(a.fechaHora || '').localeCompare(String(b.fechaHora || '')));
  if (certs.length) {
    ensure(46); // el título no se queda solo al final de una página
    texto('Certificaciones', { size: 13, bold: true, color: [30, 42, 90] });
    y += 1;
    for (const c of certs) {
      const firma = imagenSegura(c.firmaDibujada);
      ensure(firma ? 24 : 9);
      texto(`${TIPO_CERT[c.tipo] || c.tipo} ${c.refCodigo || ''} - ${ACCION_CERT[c.accion] || c.accion}${c.nivel === 2 ? ' (segunda firma)' : ''}`, { size: 10, bold: true });
      texto(`${c.firmanteNombre || c.firmadoPor}${c.firmanteCargo ? ', ' + c.firmanteCargo : ''} - ${fechaHora(c.fechaHora)}${c.comentario ? ' - ' + c.comentario : ''}`, { size: 9, color: [90, 90, 90] });
      if (firma) {
        try {
          const pr = doc.getImageProperties(firma);
          const h = 14;
          doc.addImage(firma, formato(firma), MARGEN, y, Math.min(50, (pr.width / pr.height) * h), h);
          y += h + 2;
        } catch {
          /* se omite */
        }
      }
      y += 2;
    }
  }

  // Pie de página
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(130, 130, 130);
    doc.text(`${p.nombre || ''}  -  Entrega ${entrega?.version || ''}`.slice(0, 95), MARGEN, 290);
    doc.text(`Pagina ${i} de ${total}`, 210 - MARGEN, 290, { align: 'right' });
  }
  return doc.output('blob');
}
