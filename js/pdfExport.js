import { blobToDataURL, formatDate } from './utils.js';

function getImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * Construye un informe PDF tipo inspección: portada (con el nombre y la
 * descripción de la carpeta) + una sección por foto (imagen, fecha y nota
 * si la tiene). Devuelve un Blob del PDF.
 */
export async function buildInspectionPDF({ folder, photos }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;
  const contentW = pageW - margin * 2;

  // Portada
  doc.setFontSize(20);
  doc.text(folder.name, margin, 30, { maxWidth: contentW });
  let coverY = 42;
  if (folder.description) {
    doc.setFontSize(12);
    doc.setTextColor(60);
    const descLines = doc.splitTextToSize(folder.description, contentW);
    doc.text(descLines, margin, coverY);
    coverY += descLines.length * 6 + 6;
    doc.setTextColor(0);
  }
  doc.setFontSize(11);
  doc.setTextColor(100);
  doc.text(`Generado: ${formatDate(Date.now())}`, margin, coverY);
  doc.text(`Fotos incluidas: ${photos.length}`, margin, coverY + 7);
  doc.setTextColor(0);

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    doc.addPage();
    let cursorY = margin;

    doc.setFontSize(14);
    doc.text(photo.title ? `${i + 1}. ${photo.title}` : `Foto ${i + 1}`, margin, cursorY, { maxWidth: contentW });
    cursorY += 7;

    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(formatDate(photo.createdAt), margin, cursorY);
    doc.setTextColor(0);
    cursorY += 6;

    const dataUrl = await blobToDataURL(photo.blob);
    const dims = await getImageDimensions(dataUrl);
    const maxImgH = 150;
    let imgW = contentW;
    let imgH = (dims.height / dims.width) * imgW;
    if (imgH > maxImgH) {
      imgH = maxImgH;
      imgW = (dims.width / dims.height) * imgH;
    }
    const imgX = margin + (contentW - imgW) / 2;
    doc.addImage(dataUrl, 'JPEG', imgX, cursorY, imgW, imgH, undefined, 'MEDIUM');
    cursorY += imgH + 8;

    if (photo.note) {
      doc.setFontSize(11);
      const lines = doc.splitTextToSize(photo.note, contentW);
      for (const line of lines) {
        if (cursorY > pageH - margin) {
          doc.addPage();
          cursorY = margin;
        }
        doc.text(line, margin, cursorY);
        cursorY += 6;
      }
    }
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
