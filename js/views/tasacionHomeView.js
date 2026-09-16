import { getAllTasacionEstudios, createTasacionEstudio, deleteTasacionEstudio } from '../db.js';
import { parseTasacionXLSX } from '../tasacionExcelParser.js';
import { navigate } from '../router.js';
import { toast, escapeHTML, confirmDialog, uuid } from '../utils.js';

/** Convierte lo que trae el Excel (unidades/tipologías/refs) en el shape
 * que guarda db.js: tipologías resumidas + muestras (las refs del propio
 * informe, ya aprobadas de entrada — el tasador ya las eligió a mano al
 * armar su informe, no necesitan pasar por la cola de revisión). */
function toEstudioInput(parsed) {
  const muestras = parsed.refs.map((r) => ({
    id: uuid(),
    tipo: r.tipo,
    origen: 'ref-tipologia',
    kind: 'ref',
    direccion: r.direccion,
    calidad: r.calidad,
    m2Const: r.m2Const,
    ufm2: r.ufm2,
    valorTotal: r.valorTotal,
    link: r.link,
    lat: null,
    lon: null,
    dist: null,
    estado: 'aprobada',
  }));
  return {
    ao: parsed.ao,
    nombreProyecto: parsed.nombreProyecto,
    direccion: parsed.direccion,
    comuna: parsed.comuna,
    region: parsed.region,
    fechaVisita: parsed.fechaVisita,
    ufTasacionFecha: parsed.ufTasacionFecha,
    tipologias: parsed.tipologias,
    muestras,
  };
}

export async function renderTasacionHomeView(container) {
  let estudios = await getAllTasacionEstudios();

  function paint() {
    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back-home" title="Volver a Banco">←</button>
        <span class="header-title">Estudio de mercado</span>
      </header>
      <main class="view-content">
        <div class="tasacion-row" style="padding: 12px;">
          <input type="file" id="input-excel" accept=".xlsx,.xls" hidden />
          <button class="btn btn-secondary" id="btn-import">📥 Importar Excel de tasación</button>
        </div>
        ${estudios.length ? `
          <section class="obra-grid">
            ${estudios.map((e) => `
              <div class="obra-tile-wrap">
                <button class="obra-tile" data-id="${e.id}">
                  <span class="obra-icon">📊</span>
                  <span class="obra-name">${escapeHTML(e.nombreProyecto || e.ao || 'Sin nombre')}</span>
                </button>
                <button class="obra-delete-btn" data-delete-id="${e.id}" title="Eliminar">🗑️</button>
              </div>
            `).join('')}
          </section>
        ` : `
          <div class="empty-state">
            <p>Todavía no hay estudios de mercado.</p>
            <p>Importa el Excel de una tasación para generar el primero.</p>
          </div>
        `}
      </main>
    `;

    container.querySelector('#btn-back-home').addEventListener('click', () => navigate('/banco'));

    container.querySelectorAll('.obra-tile').forEach((tile) => {
      tile.addEventListener('click', () => navigate(`/banco/estudio-mercado/${tile.dataset.id}`));
    });

    container.querySelectorAll('.obra-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('¿Eliminar este estudio de mercado? No se puede deshacer (el respaldo en Drive, si ya lo subiste, no se borra solo).');
        if (!ok) return;
        await deleteTasacionEstudio(btn.dataset.deleteId);
        estudios = await getAllTasacionEstudios();
        toast('Estudio eliminado.');
        paint();
      });
    });

    const input = container.querySelector('#input-excel');
    container.querySelector('#btn-import').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      toast('Leyendo el Excel…');
      try {
        const buf = await file.arrayBuffer();
        const parsed = parseTasacionXLSX(buf);
        const estudio = await createTasacionEstudio({ ...toEstudioInput(parsed), sourceFileName: file.name });
        toast(`Importado: ${parsed.tipologias.length} tipologías, ${parsed.refs.length} referencias.`);
        navigate(`/banco/estudio-mercado/${estudio.id}`);
      } catch (err) {
        console.error('Error importando Excel de tasación:', err);
        toast(`⚠️ ${err.message || 'No se pudo leer el Excel.'}`);
      }
    });
  }

  paint();
}
