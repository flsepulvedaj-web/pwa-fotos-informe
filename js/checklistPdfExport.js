// PDF del Checklist diario — un PDF por tipo/día, para que quede un
// respaldo que se pueda ABRIR Y LEER directo en Drive (antes solo se
// guardaba el .json crudo, que solo la app misma puede interpretar).
// Mismo patrón general que protocolPdfExport.js (jsPDF, mm/a4, título +
// campos de encabezado + tabla + fotos + pie de página).
import { blobToDataURL } from './utils.js';
import { getImageDimensions, drawContainedImage } from './pdfExport.js';
import { CHECKLIST_STATUS } from './controlChecklistTemplates.js';

const STATUS_COLOR = {
  SI: [46, 125, 50],
  NO_ENTREGADO: [220, 38, 38],
  INCOMPLETO: [230, 150, 30],
  N_A: [107, 114, 128],
  EN_REVISION: [37, 99, 235],
  NO_LO_TIENEN: [220, 38, 38],
};

function statusLabel(id) {
  const s = CHECKLIST_STATUS.find((c) => c.id === id);
  return s ? s.label.toUpperCase() : '— SIN CONTESTAR —';
}

function statusColor(id) {
  return STATUS_COLOR[id] || [180, 180, 180];
}

function formatDateEs(iso) {
  if (!iso) return '—';
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * `items`: la lista YA COMBINADA con la plantilla vigente (mismo shape que
 * mergeEntryItemsWithTemplate en controlChecklistView.js — {label, nota,
 * status, observacion}), para que el PDF muestre siempre el texto y el
 * estado reales de ese día, igual que la pantalla.
 */
export async function buildChecklistPDF({ obraName, typeTitle, date, items, photos }, onProgress) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 12;
  const contentW = pageW - margin * 2;
  const bottomLimit = pageH - margin - 6;

  let totalSteps = 1 + (photos.length ? Math.ceil(photos.length / 4) : 0);
  let step = 0;
  const reportProgress = () => {
    step++;
    if (onProgress) onProgress(step, totalSteps);
  };

  function drawTitleBlock() {
    doc.setFont(undefined, 'bold');
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text('CHECKLIST DIARIO', margin, margin);
    doc.setFontSize(14);
    doc.setTextColor(0);
    doc.text(typeTitle, margin, margin + 8);
    doc.setDrawColor(28, 43, 74);
    doc.setLineWidth(0.5);
    doc.line(margin, margin + 11, pageW - margin, margin + 11);
    return margin + 18;
  }

  function drawHeaderFields(y) {
    doc.setFontSize(9);
    doc.setFont(undefined, 'bold');
    doc.text('Obra:', margin, y);
    doc.setFont(undefined, 'normal');
    doc.text(obraName || '—', margin + 16, y, { maxWidth: contentW / 2 - 18 });
    doc.setFont(undefined, 'bold');
    doc.text('Fecha:', margin + contentW / 2, y);
    doc.setFont(undefined, 'normal');
    doc.text(formatDateEs(date), margin + contentW / 2 + 16, y);
    return y + 8;
  }

  function pageFooter(pageNum, totalPages) {
    doc.setFontSize(7.5);
    doc.setTextColor(130);
    doc.text(`Página ${pageNum} de ${totalPages}`, pageW - margin, pageH - 5, { align: 'right' });
    doc.setTextColor(0);
  }

  // ---- Encabezado + tabla de ítems ----
  let y = drawTitleBlock();
  y = drawHeaderFields(y);

  doc.setFont(undefined, 'bold');
  doc.setFontSize(10);
  doc.text('ÍTEMS', margin, y);
  y += 6;

  for (const item of items) {
    // Alto variable: crece si el label/observación no entra en 1 línea.
    doc.setFontSize(9.5);
    const labelLines = doc.splitTextToSize(item.label, contentW - 50);
    doc.setFontSize(7.5);
    const instrLines = item.nota ? doc.splitTextToSize(item.nota, contentW - 50) : [];
    doc.setFontSize(8.5);
    const obsLines = item.observacion ? doc.splitTextToSize(`Observación: ${item.observacion}`, contentW - 4) : [];
    const rowH = Math.max(19, 6 + labelLines.length * 4 + instrLines.length * 3.2) + obsLines.length * 4;

    if (y + rowH > bottomLimit) {
      doc.addPage();
      y = drawTitleBlock();
    }
    doc.setDrawColor(210);
    doc.rect(margin, y, contentW, rowH);

    doc.setFont(undefined, 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(0);
    doc.text(labelLines, margin + 2, y + 5);

    let textY = y + 5 + labelLines.length * 4;
    if (instrLines.length) {
      doc.setFont(undefined, 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(100);
      doc.text(instrLines, margin + 2, textY + 1);
      textY += instrLines.length * 3.2;
    }
    if (obsLines.length) {
      doc.setFont(undefined, 'italic');
      doc.setFontSize(8.5);
      doc.setTextColor(60);
      doc.text(obsLines, margin + 2, textY + 3);
    }
    doc.setTextColor(0);
    doc.setFont(undefined, 'normal');

    const color = statusColor(item.status);
    doc.setFillColor(...color);
    doc.roundedRect(margin + contentW - 44, y + 4, 42, 8, 1.5, 1.5, 'F');
    doc.setFont(undefined, 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(255, 255, 255);
    doc.text(statusLabel(item.status), margin + contentW - 23, y + 9, { align: 'center', maxWidth: 40 });
    doc.setTextColor(0);

    y += rowH;
  }
  reportProgress();

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
        console.error('Error agregando foto al PDF del checklist:', err);
      }
    }
  }

  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    pageFooter(p, totalPages);
  }

  return doc.output('blob');
}
