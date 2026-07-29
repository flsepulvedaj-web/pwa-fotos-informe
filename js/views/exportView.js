import { buildInspectionPDF, downloadBlob, sanitizeFilename } from '../pdfExport.js';

export async function exportFolderReport({ folderName, photos }) {
  const title = `Informe - ${folderName}`;
  const blob = await buildInspectionPDF({ title, photos });
  const filename = `${sanitizeFilename(folderName)}-informe.pdf`;
  downloadBlob(blob, filename);
}
