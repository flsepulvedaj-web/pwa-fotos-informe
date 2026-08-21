import { getAllObras, createObra } from '../db.js';
import { isSignedIn } from '../googleDrive.js';
import { syncObrasFromDrive, uploadObrasIndex } from '../obraSync.js';
import { navigate } from '../router.js';
import { promptDialog, toast, escapeHTML } from '../utils.js';

/**
 * Pantalla de inicio del módulo Control: lista de obras (las mismas que usa
 * Protocolos — misma tabla `obras`, mismo id). Cada obra tiene su propio
 * dashboard de KPI, programación, checklist diario, SSMA y actas.
 *
 * Al abrir, sincroniza en segundo plano la LISTA de obras con Drive — antes
 * cada persona tenía que crear sus propias obras a mano y nunca coincidían
 * entre teléfonos (los ids eran solo locales); ahora la obra que crea
 * cualquiera del equipo le llega al resto.
 */
export async function renderControlHomeView(container) {
  let obras = await getAllObras();

  function paint() {
    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back-home" title="Volver al inicio">←</button>
        <span class="header-title">Control</span>
      </header>
      <main class="view-content">
        ${obras.length ? `
          <section class="obra-grid">
            ${obras.map((o) => `
              <button class="obra-tile" data-obra-id="${o.id}">
                <span class="obra-icon">🎛️</span>
                <span class="obra-name">${escapeHTML(o.name)}</span>
              </button>
            `).join('')}
          </section>
        ` : `
          <div class="empty-state">
            <p>Todavía no hay obras.</p>
            <p>Crea una para empezar a llevar su control.</p>
          </div>
        `}
      </main>
      <div class="fab-row">
        <button class="fab fab-primary" id="btn-new-obra" title="Nueva obra">🏗️➕</button>
      </div>
    `;

    container.querySelector('#btn-back-home').addEventListener('click', () => navigate('/proyectos'));

    container.querySelectorAll('.obra-tile').forEach((tile) => {
      tile.addEventListener('click', () => navigate(`/control/obra/${tile.dataset.obraId}`));
    });

    container.querySelector('#btn-new-obra').addEventListener('click', async () => {
      const result = await promptDialog({
        title: 'Nueva obra',
        fields: [{ name: 'name', label: 'Nombre de la obra', placeholder: 'Ej: Villa Los Aromos' }],
        confirmLabel: 'Crear',
      });
      if (result && result.name) {
        await createObra(result.name);
        toast('Obra creada.');
        obras = await getAllObras();
        paint();
        uploadObrasIndex(); // best-effort, no bloquea — le llega al resto del equipo
      }
    });
  }

  paint();

  // Sync en segundo plano — nunca dispara el popup de sesión de Google.
  if (isSignedIn()) {
    syncObrasFromDrive().then(async (changed) => {
      if (changed) {
        obras = await getAllObras();
        toast(`📥 ${changed} obra(s) traída(s) del equipo.`);
        paint();
      }
    }).catch((err) => console.error('Error sincronizando obras desde Drive:', err));
  }
}
