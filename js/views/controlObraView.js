import { getObra } from '../db.js';
import { navigate } from '../router.js';
import { escapeHTML } from '../utils.js';

/**
 * Pantalla principal de Control para una obra: accesos a cada sección
 * (Programación, Checklist diario, SSMA, Actas) + más adelante el dashboard
 * de KPI con gráficos históricos e incumplimientos. Se va llenando por
 * fases — las secciones que todavía no están construidas se muestran
 * marcadas como "Próximamente" en vez de romper la navegación.
 */
export async function renderControlObraView(container, obraId) {
  const obra = await getObra(obraId);
  if (!obra) {
    navigate('/control');
    return;
  }

  const sections = [
    { id: 'ssma', icon: '👷', title: 'SSMA', desc: 'Personal en obra por día', ready: true },
    { id: 'checklist', icon: '✅', title: 'Checklist diario', desc: 'Cumplimiento + fotos del día', ready: false },
    { id: 'programacion', icon: '📅', title: 'Programación', desc: 'Avance planificado vs. real', ready: false },
    { id: 'actas', icon: '📝', title: 'Actas de reunión', desc: 'Asistentes, temas, acuerdos', ready: false },
  ];

  container.innerHTML = `
    <header class="app-header">
      <button class="icon-btn" id="btn-back" title="Volver">←</button>
      <span class="header-title">${escapeHTML(obra.name)}</span>
    </header>
    <main class="view-content">
      <section class="control-section-grid">
        ${sections.map((s) => `
          <button type="button" class="module-card control-section-card${s.ready ? '' : ' control-section-soon'}" data-section="${s.id}">
            <span class="module-icon">${s.icon}</span>
            <span class="module-title">${s.title}</span>
            <span class="module-desc">${s.ready ? s.desc : 'Próximamente'}</span>
          </button>
        `).join('')}
      </section>
    </main>
  `;

  container.querySelector('#btn-back').addEventListener('click', () => navigate('/control'));

  container.querySelectorAll('.control-section-card').forEach((card) => {
    card.addEventListener('click', () => {
      const section = card.dataset.section;
      if (section === 'ssma') {
        navigate(`/control/obra/${obraId}/ssma`);
      }
      // Las demás secciones todavía no tienen vista — no hacen nada al
      // tocarlas (quedan visibles para mostrar el mapa completo del módulo).
    });
  });
}
