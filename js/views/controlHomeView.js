import { getAllObras, createObra } from '../db.js';
import { isSignedIn, getSignedInEmail } from '../googleDrive.js';
import { isAdmin } from '../permissions.js';
import { syncObrasFromDrive, uploadObrasIndex, deleteObraEverywhere } from '../obraSync.js';
import { navigate } from '../router.js';
import { promptDialog, confirmDialog, toast, escapeHTML } from '../utils.js';

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
  const email = await getSignedInEmail();
  const admin = isAdmin(email);

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
              <div class="obra-tile-wrap">
                <button class="obra-tile" data-obra-id="${o.id}">
                  <span class="obra-icon">🎛️</span>
                  <span class="obra-name">${escapeHTML(o.name)}</span>
                </button>
                ${admin ? `<button class="obra-delete-btn" data-delete-obra-id="${o.id}" title="Eliminar obra">🗑️</button>` : ''}
              </div>
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

    container.querySelectorAll('.obra-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('¿Eliminar esta obra? Se borra TODO lo que tenga cargado en Protocolos, Control, Costos, RDI, Subcontratos, Organismos e Informe Semanal — y este borrado le va a llegar también a los demás teléfonos del equipo (Jessi, Sergio) la próxima vez que abran la app. No se puede deshacer.');
        if (!ok) return;
        toast('Eliminando…');
        await deleteObraEverywhere(btn.dataset.deleteObraId);
        obras = await getAllObras();
        toast('Obra eliminada — se va a propagar al resto del equipo.');
        paint();
      });
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
      // Sube igual, aunque no haya cambiado nada al bajar — así una obra
      // creada antes de que existiera esta sincronización (o en un
      // dispositivo que nunca volvió a tocar "Nueva obra" después) igual
      // termina en el índice compartido, sin que nadie tenga que hacer
      // nada manual. Cada apertura de Control autorepara el índice.
      uploadObrasIndex();
    }).catch((err) => console.error('Error sincronizando obras desde Drive:', err));
  }
}
