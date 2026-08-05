import { blobToDataURL } from './utils.js';
import { getImageDimensions, drawContainedImage } from './pdfExport.js';
import { CONTROL_STATUS, SIGNATURE_ROLES } from './protocolTemplates.js';

const STATUS_COLOR = {
  CUMPLE: [46, 125, 50],
  NO_CUMPLE: [220, 38, 38],
  CUMPLE_PARCIAL: [230, 150, 30],
  N_A: [107, 114, 128],
};

function statusLabel(id) {
  const s = CONTROL_STATUS.find((c) => c.id === id);
  return s ? s.label.toUpperCase() : '— SIN MARCAR —';
}

function statusColor(id) {
  return STATUS_COLOR[id] || [180, 180, 180];
}

/**
 * Arma el PDF final de un protocolo: encabezado, tabla de puntos de
 * control, observaciones, plano, fotografías y las 4 firmas (una sola vez,
 * al final — el Excel original las repite en cada una de sus 3 "páginas"
 * porque podían imprimirse sueltas, acá no hace falta). Mismo patrón
 * general de pdfExport.js (jsPDF, mm/a4).
 */
export async function buildProtocolPDF({ templateTitle, header, controlPoints, observaciones, plano, photos, signatures }, onProgress) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 12;
  const contentW = pageW - margin * 2;
  const bottomLimit = pageH - margin - 6;

  let totalSteps = 1 + (plano ? 1 : 0) + (photos.length ? Math.ceil(photos.length / 4) : 0) + 1;
  let step = 0;
  const reportProgress = () => {
    step++;
    if (onProgress) onProgress(step, totalSteps);
  };

  function drawTitleBlock() {
    doc.setFont(undefined, 'bold');
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text('CONTROL DE CALIDAD', margin, margin);
    doc.setFontSize(14);
    doc.setTextColor(0);
    doc.text(templateTitle, margin, margin + 8);
    doc.setDrawColor(28, 43, 74);
    doc.setLineWidth(0.5);
    doc.line(margin, margin + 11, pageW - margin, margin + 11);
    return margin + 18;
  }

  function drawHeaderFields(y) {
    const fields = [
      ['Obra', header.obra], ['Cliente', header.cliente],
      ['Ubicación', header.ubicacion], ['Área', header.area],
      ['Plano', header.plano], ['Sector', header.sector],
    ];
    doc.setFontSize(9);
    const colW = contentW / 2;
    let maxY = y;
    fields.forEach(([label, value], i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = margin + col * colW;
      const rowY = y + row * 6;
      doc.setFont(undefined, 'bold');
      doc.text(`${label}:`, x, rowY);
      doc.setFont(undefined, 'normal');
      doc.text(value || '—', x + 24, rowY, { maxWidth: colW - 26 });
      maxY = Math.max(maxY, rowY);
    });
    return maxY + 8;
  }

  function pageFooter(pageNum, totalPages) {
    doc.setFontSize(7.5);
    doc.setTextColor(130);
    doc.text(`Página ${pageNum} de ${totalPages}`, pageW - margin, pageH - 5, { align: 'right' });
    doc.setTextColor(0);
  }

  // ---- Página 1+: encabezado y tabla de puntos de control ----
  let y = drawTitleBlock();
  y = drawHeaderFields(y);

  doc.setFont(undefined, 'bold');
  doc.setFontSize(10);
  doc.text('PUNTOS DE CONTROL', margin, y);
  y += 6;

  const ROW_H = 19;
  for (const cp of controlPoints) {
    if (y + ROW_H > bottomLimit) {
      doc.addPage();
      y = drawTitleBlock();
    }
    doc.setDrawColor(210);
    doc.rect(margin, y, contentW, ROW_H);

    doc.setFont(undefined, 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(0);
    const labelLines = doc.splitTextToSize(cp.label, contentW - 50);
    doc.text(labelLines.slice(0, 1), margin + 2, y + 5);

    doc.setFont(undefined, 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100);
    const instrLines = doc.splitTextToSize(cp.instruction || '', contentW - 50);
    doc.text(instrLines.slice(0, 2), margin + 2, y + 10);
    doc.setTextColor(0);

    const color = statusColor(cp.status);
    doc.setFillColor(...color);
    doc.roundedRect(margin + contentW - 44, y + ROW_H / 2 - 4, 42, 8, 1.5, 1.5, 'F');
    doc.setFont(undefined, 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(255, 255, 255);
    doc.text(statusLabel(cp.status), margin + contentW - 23, y + ROW_H / 2 + 0.8, { align: 'center', maxWidth: 40 });
    doc.setTextColor(0);

    y += ROW_H;
  }

  if (observaciones) {
    if (y + 20 > bottomLimit) {
      doc.addPage();
      y = drawTitleBlock();
    }
    y += 4;
    doc.setFont(undefined, 'bold');
    doc.setFontSize(10);
    doc.text('OBSERVACIONES', margin, y);
    y += 5;
    doc.setFont(undefined, 'normal');
    doc.setFontSize(9);
    const obsLines = doc.splitTextToSize(observaciones, contentW);
    doc.text(obsLines, margin, y);
  }
  reportProgress();

  // ---- Planimetría ----
  if (plano) {
    doc.addPage();
    let py = drawTitleBlock();
    doc.setFont(undefined, 'bold');
    doc.setFontSize(10);
    doc.text('PLANIMETRÍA', margin, py);
    py += 6;
    try {
      const dataUrl = await blobToDataURL(plano.blob);
      const dims = await getImageDimensions(dataUrl);
      const format = plano.blob.type.includes('png') ? 'PNG' : 'JPEG';
      doc.setDrawColor(210);
      const boxH = bottomLimit - py;
      doc.rect(margin, py, contentW, boxH);
      drawContainedImage(doc, dataUrl, dims, margin + 2, py + 2, contentW - 4, boxH - 4, format);
    } catch (err) {
      console.error('Error agregando el plano al PDF:', err);
    }
    reportProgress();
  }

  // ---- Fotografías ----
  if (photos.length) {
    const PER_PAGE = 4;
    const colGap = 4;
    const rowGap = 4;
    const colW = (contentW - colGap) / 2;
    const imageH = 78;
    for (let i = 0; i < photos.length; i++) {
      if (i % PER_PAGE === 0) {
        doc.addPage();
        let fy = drawTitleBlock();
        doc.setFont(undefined, 'bold');
        doc.setFontSize(10);
        doc.text('FOTOGRAFÍAS', margin, fy);
        doc._fotosTop = fy + 6;
        reportProgress();
      }
      const idxInPage = i % PER_PAGE;
      const col = idxInPage % 2;
      const row = Math.floor(idxInPage / 2);
      const cellX = margin + col * (colW + colGap);
      const cellY = doc._fotosTop + row * (imageH + rowGap);
      doc.setDrawColor(210);
      doc.rect(cellX, cellY, colW, imageH);
      try {
        const dataUrl = await blobToDataURL(photos[i].blob);
        const dims = await getImageDimensions(dataUrl);
        drawContainedImage(doc, dataUrl, dims, cellX + 1.5, cellY + 1.5, colW - 3, imageH - 3, 'JPEG');
      } catch (err) {
        console.error('Error agregando foto al PDF:', err);
      }
    }
  }

  // ---- Firmas (una sola vez, al final) ----
  doc.addPage();
  let sy = drawTitleBlock();
  doc.setFont(undefined, 'bold');
  doc.setFontSize(10);
  doc.text('FIRMAS', margin, sy);
  sy += 8;

  const sigColW = (contentW - 6) / 2;
  const sigRowH = 52;
  for (let i = 0; i < SIGNATURE_ROLES.length; i++) {
    const role = SIGNATURE_ROLES[i];
    const sig = signatures?.[role.id];
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = margin + col * (sigColW + 6);
    const boxY = sy + row * (sigRowH + 6);

    doc.setDrawColor(210);
    doc.rect(x, boxY, sigColW, sigRowH);
    doc.setFont(undefined, 'bold');
    doc.setFontSize(9);
    doc.text(role.label, x + 2, boxY + 6);
    doc.setFont(undefined, 'normal');
    doc.setFontSize(8);
    doc.text(`Nombre: ${sig?.nombre || '—'}`, x + 2, boxY + 12);
    doc.text(`Fecha: ${sig?.fecha ? new Date(sig.fecha).toLocaleDateString('es-CL') : '—'}`, x + 2, boxY + 17);

    if (sig?.signatureBlob) {
      try {
        const dataUrl = await blobToDataURL(sig.signatureBlob);
        const dims = await getImageDimensions(dataUrl);
        drawContainedImage(doc, dataUrl, dims, x + 2, boxY + 19, sigColW - 4, sigRowH - 21, 'PNG');
      } catch (err) {
        console.error('Error agregando firma al PDF:', err);
      }
    }
  }
  reportProgress();

  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    pageFooter(p, totalPages);
  }

  return doc.output('blob');
}
