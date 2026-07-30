import { blobToDataURL } from './utils.js';

const PHOTOS_PER_PAGE = 8;
const GRID_COLS = 2;
const GRID_ROWS = 4;
const BANNER_COLOR = [226, 107, 10]; // naranjo del formato "Fotografías Desarrollo de Obras"

function getImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function drawContainedImage(doc, dataUrl, dims, boxX, boxY, boxW, boxH) {
  let w = boxW;
  let h = (dims.height / dims.width) * w;
  if (h > boxH) {
    h = boxH;
    w = (dims.width / dims.height) * h;
  }
  const x = boxX + (boxW - w) / 2;
  const y = boxY + (boxH - h) / 2;
  doc.addImage(dataUrl, 'JPEG', x, y, w, h, undefined, 'MEDIUM');
}

function drawHeader(doc, { obra, reportNumber, period }, pageW, margin) {
  const contentW = pageW - margin * 2;
  let y = margin + 4;

  doc.setFont(undefined, 'bold');
  doc.setFontSize(10);
  doc.setTextColor(0);
  doc.text(`OBRA: ${obra || 'Sin nombre'}`, margin, y);

  const infoLine = `Informe de Avance N° ${reportNumber || '-'} de ${period || '-'}`;
  doc.setFont(undefined, 'normal');
  doc.text(infoLine, margin + contentW, y, { align: 'right' });

  y += 5;
  doc.setFillColor(...BANNER_COLOR);
  doc.rect(margin, y, contentW, 7, 'F');
  doc.setFont(undefined, 'bold');
  doc.setFontSize(11);
  doc.setTextColor(255, 255, 255);
  doc.text('FOTOGRAFÍAS DESARROLLO DE OBRAS', margin + contentW / 2, y + 4.8, { align: 'center' });
  doc.setTextColor(0);
  doc.setFont(undefined, 'normal');
  y += 11;

  doc.setFontSize(8);
  doc.setTextColor(90);
  const subtitle = 'Corresponde a fotografías tomadas en terreno durante la visita que representan el avance informado.';
  const subtitleLines = doc.splitTextToSize(subtitle, contentW);
  doc.text(subtitleLines, margin + contentW / 2, y, { align: 'center' });
  doc.setTextColor(0);
  y += subtitleLines.length * 3.6 + 3;

  return y;
}

/**
 * Construye el informe PDF en el formato oficial "Fotografías Desarrollo de
 * Obras": encabezado con obra / N° de informe / período, y una grilla de
 * 2×4 (8 fotos) por página, repitiendo el encabezado en cada una. La
 * cantidad de páginas se calcula sola según cuántas fotos vengan. Usa
 * `photo.title` como el texto de "Imagen N:" (ya debe venir guardado antes
 * de llamar esta función). `onProgress(pageIndex, totalPages)` es opcional,
 * para mostrar avance en exportaciones grandes.
 */
export async function buildObraReportPDF({ obra, reportNumber, period, photos }, onProgress) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 8;
  const contentW = pageW - margin * 2;

  const totalPages = Math.max(1, Math.ceil(photos.length / PHOTOS_PER_PAGE));
  const colGap = 4;
  const rowGap = 4;
  const colW = (contentW - colGap * (GRID_COLS - 1)) / GRID_COLS;
  const imageH = 48;
  const captionH = 10;
  const rowH = imageH + captionH;

  for (let page = 0; page < totalPages; page++) {
    if (page > 0) doc.addPage();
    const gridTop = drawHeader(doc, { obra, reportNumber, period }, pageW, margin) + 2;

    const pagePhotos = photos.slice(page * PHOTOS_PER_PAGE, page * PHOTOS_PER_PAGE + PHOTOS_PER_PAGE);
    for (let i = 0; i < pagePhotos.length; i++) {
      const photo = pagePhotos[i];
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      const cellX = margin + col * (colW + colGap);
      const cellY = gridTop + row * (rowH + rowGap);
      const imgNumber = page * PHOTOS_PER_PAGE + i + 1;

      doc.setDrawColor(150);
      doc.rect(cellX, cellY, colW, imageH);
      try {
        const dataUrl = await blobToDataURL(photo.blob);
        const dims = await getImageDimensions(dataUrl);
        drawContainedImage(doc, dataUrl, dims, cellX + 0.8, cellY + 0.8, colW - 1.6, imageH - 1.6);
      } catch (err) {
        console.error('Error agregando imagen al PDF:', err);
      }

      const capY = cellY + imageH;
      doc.rect(cellX, capY, colW, captionH);
      doc.setFontSize(8.5);
      doc.setFont(undefined, 'bold');
      doc.text(`Imagen ${imgNumber}:`, cellX + 1.5, capY + 4);
      doc.setFont(undefined, 'normal');
      const captionLines = doc.splitTextToSize(photo.title || '', colW - 3);
      doc.text(captionLines.slice(0, 2), cellX + 1.5, capY + 8);
    }

    doc.setFontSize(7.5);
    doc.setTextColor(130);
    doc.text(`Página ${page + 1} de ${totalPages}`, pageW - margin, pageH - 4, { align: 'right' });
    doc.setTextColor(0);

    if (onProgress) onProgress(page + 1, totalPages);
  }

  return doc.output('blob');
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function sanitizeFilename(name) {
  return (name || 'informe').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'informe';
}
