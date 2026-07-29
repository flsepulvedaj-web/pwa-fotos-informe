import { buildInspectionPDF, downloadBlob, sanitizeFilename } from '../pdfExport.js';

export async function exportFolderReport({ folder, photos }) {
  const blob = await buildInspectionPDF({ folder, photos });
  const filename = `${sanitizeFilename(folder.name)}-informe.pdf`;
  downloadBlob(blob, filename);
}
