import { blobToDataURL } from './utils.js';
import { getImageDimensions, drawContainedImage } from './pdfExport.js';

function formatDateEs(iso) {
  if (!iso) return '—';
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * Arma el PDF del Informe Semanal: datos de la reunión, participantes,
 * temas conversados, el compilado de KPI (como texto — sin gráficos, ver
 * nota en el plan) y fotos de la semana, y las firmas de TODOS los
 * participantes que hayan firmado (no una lista fija de roles como
 * Protocolos, acá puede ser cualquier cantidad de gente). Mismo motor
 * general (jsPDF, mm/a4) que protocolPdfExport.js.
 */
export async function buildInformeSemanalPDF({ obraName, informe, compilado }, onProgress) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 12;
  const contentW = pageW - margin * 2;
  const bottomLimit = pageH - margin - 6;

  const firmantes = [
    ...informe.participantesConstructora.filter((p) => p.firmaBlob),
    ...informe.participantesLen.filter((p) => p.firmaBlob),
  ];

  let totalSteps = 1 + (compilado.fotos.length ? Math.ceil(compilado.fotos.length / 4) : 0) + (firmantes.length ? 1 : 0);
  let step = 0;
  const reportProgress = () => {
    step++;
    if (onProgress) onProgress(step, totalSteps);
  };

  function drawTitleBlock() {
    doc.setFont(undefined, 'bold');
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text('INFORME SEMANAL', margin, margin);
    doc.setFontSize(14);
    doc.setTextColor(0);
    doc.text(obraName, margin, margin + 8);
    doc.setDrawColor(28, 43, 74);
    doc.setLineWidth(0.5);
    doc.line(margin, margin + 11, pageW - margin, margin + 11);
    return margin + 18;
  }

  function pageFooter(pageNum, totalPages) {
    doc.setFontSize(7.5);
    doc.setTextColor(130);
    doc.text(`Página ${pageNum} de ${totalPages}`, pageW - margin, pageH - 5, { align: 'right' });
    doc.setTextColor(0);
  }

  function drawParticipantesTable(title, participantes, y) {
    if (y + 14 > bottomLimit) {
      doc.addPage();
      y = drawTitleBlock();
    }
    doc.setFont(undefined, 'bold');
    doc.setFontSize(9.5);
    doc.text(title, margin, y);
    y += 5;
    if (!participantes.length) {
      doc.setFont(undefined, 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(130);
      doc.text('— Sin participantes cargados —', margin, y);
      doc.setTextColor(0);
      return y + 6;
    }
    doc.setFontSize(8.5);
    for (const p of participantes) {
      if (y + 6 > bottomLimit) {
        doc.addPage();
        y = drawTitleBlock();
      }
      doc.setFont(undefined, 'bold');
      doc.text(p.nombre || '—', margin, y);
      doc.setFont(undefined, 'normal');
      doc.text(p.cargo || '', margin + 60, y, { maxWidth: contentW - 60 });
      y += 5.5;
    }
    return y + 3;
  }

  // ---- Página 1: encabezado, participantes, temas ----
  let y = drawTitleBlock();

  doc.setFont(undefined, 'normal');
  doc.setFontSize(9);
  doc.text(`Fecha: ${formatDateEs(informe.fecha)}    Lugar: ${informe.lugar || '—'}    Hora: ${informe.horaInicio || '—'}`, margin, y);
  y += 5;
  if (informe.reunionTitulo) {
    doc.setFont(undefined, 'bold');
    doc.text(informe.reunionTitulo, margin, y);
    y += 6;
  } else {
    y += 2;
  }

  y = drawParticipantesTable('PARTICIPANTES — POR CONSTRUCTORA', informe.participantesConstructora, y);
  y = drawParticipantesTable('PARTICIPANTES — POR LEN / ENEX', informe.participantesLen, y);

  if (y + 12 > bottomLimit) {
    doc.addPage();
    y = drawTitleBlock();
  }
  doc.setFont(undefined, 'bold');
  doc.setFontSize(10);
  doc.text('TEMAS CONVERSADOS', margin, y);
  y += 6;
  doc.setFontSize(8.5);
  if (!informe.temas.length) {
    doc.setFont(undefined, 'normal');
    doc.setTextColor(130);
    doc.text('— Sin temas cargados —', margin, y);
    doc.setTextColor(0);
    y += 6;
  } else {
    informe.temas.forEach((t, i) => {
      const lines = doc.splitTextToSize(`${i + 1}. ${t.punto}${t.responsable ? ` (Responsable: ${t.responsable})` : ''}`, contentW);
      if (y + lines.length * 4.5 > bottomLimit) {
        doc.addPage();
        y = drawTitleBlock();
      }
      doc.setFont(undefined, 'normal');
      doc.text(lines, margin, y);
      y += lines.length * 4.5 + 1.5;
    });
  }

  // ---- Compilado ----
  if (y + 14 > bottomLimit) {
    doc.addPage();
    y = drawTitleBlock();
  }
  y += 3;
  doc.setFont(undefined, 'bold');
  doc.setFontSize(10);
  doc.text('COMPILADO', margin, y);
  y += 6;
  doc.setFont(undefined, 'normal');
  doc.setFontSize(8.5);
  const kpiLines = [
    `Avance programado: ${compilado.avance.latestPercent !== null ? compilado.avance.latestPercent + '%' : '—'}`,
    `Personal hoy: ${compilado.personal.todayTotal !== null ? compilado.personal.todayTotal : '—'}`,
    `Cumplimiento checklist (30d): ${compilado.checklist.cumplimientoPercent !== null ? compilado.checklist.cumplimientoPercent + '%' : '—'}`,
  ];
  if (compilado.costos) {
    kpiLines.push(`Presupuesto vigente: ${compilado.costos.moneda}${Math.round(compilado.costos.presupuestoVigente).toLocaleString('es-CL')}`);
    kpiLines.push(`Avance financiero: ${compilado.costos.avancePercent !== null ? compilado.costos.avancePercent + '%' : '—'}`);
  }
  if (compilado.rdi) {
    kpiLines.push(`RDI — promedio días de respuesta: ${compilado.rdi.promedioDias !== null ? compilado.rdi.promedioDias + 'd' : '—'}`);
    kpiLines.push(`RDI sin responder: ${compilado.rdi.pendientes}`);
  }
  for (const line of kpiLines) {
    if (y + 5 > bottomLimit) {
      doc.addPage();
      y = drawTitleBlock();
    }
    doc.text(`• ${line}`, margin, y);
    y += 5;
  }
  reportProgress();

  // ---- Fotos de la semana ----
  if (compilado.fotos.length) {
    const PER_PAGE = 4;
    const colGap = 4;
    const rowGap = 4;
    const colW = (contentW - colGap) / 2;
    const imageH = 78;
    for (let i = 0; i < compilado.fotos.length; i++) {
      if (i % PER_PAGE === 0) {
        doc.addPage();
        let fy = drawTitleBlock();
        doc.setFont(undefined, 'bold');
        doc.setFontSize(10);
        doc.text('FOTOS DE LA SEMANA', margin, fy);
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
        const dataUrl = await blobToDataURL(compilado.fotos[i].blob);
        const dims = await getImageDimensions(dataUrl);
        drawContainedImage(doc, dataUrl, dims, cellX + 1.5, cellY + 1.5, colW - 3, imageH - 3, 'JPEG');
      } catch (err) {
        console.error('Error agregando foto al PDF:', err);
      }
    }
  }

  // ---- Firmas (todos los participantes que hayan firmado) ----
  if (firmantes.length) {
    doc.addPage();
    let sy = drawTitleBlock();
    doc.setFont(undefined, 'bold');
    doc.setFontSize(10);
    doc.text('FIRMAS', margin, sy);
    sy += 8;

    const sigColW = (contentW - 6) / 2;
    const sigRowH = 46;
    for (let i = 0; i < firmantes.length; i++) {
      const p = firmantes[i];
      const idxInPage = i % 4;
      if (i > 0 && idxInPage === 0) {
        doc.addPage();
        sy = drawTitleBlock();
        doc.setFont(undefined, 'bold');
        doc.setFontSize(10);
        doc.text('FIRMAS (continuación)', margin, sy);
        sy += 8;
      }
      const col = idxInPage % 2;
      const row = Math.floor(idxInPage / 2);
      const x = margin + col * (sigColW + 6);
      const boxY = sy + row * (sigRowH + 6);

      doc.setDrawColor(210);
      doc.rect(x, boxY, sigColW, sigRowH);
      doc.setFont(undefined, 'bold');
      doc.setFontSize(8.5);
      doc.text(p.nombre || '—', x + 2, boxY + 6);
      doc.setFont(undefined, 'normal');
      doc.setFontSize(7.5);
      doc.text(p.cargo || '', x + 2, boxY + 11);

      try {
        const dataUrl = await blobToDataURL(p.firmaBlob);
        const dims = await getImageDimensions(dataUrl);
        drawContainedImage(doc, dataUrl, dims, x + 2, boxY + 13, sigColW - 4, sigRowH - 15, 'PNG');
      } catch (err) {
        console.error('Error agregando firma al PDF:', err);
      }
    }
    reportProgress();
  }

  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    pageFooter(p, totalPages);
  }

  return doc.output('blob');
}
