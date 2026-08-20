import { getSignedInEmail } from '../googleDrive.js';
import { APP_MODULES, isAdmin, fetchPermissions, savePermissions } from '../permissions.js';
import { navigate } from '../router.js';
import { escapeHTML, promptDialog, confirmDialog, toast } from '../utils.js';

/**
 * Pantalla de administración (solo Pancho por ahora): qué módulos puede
 * ver cada correo del equipo. Se guarda en Drive (permissions.json en la
 * carpeta raíz por defecto) — cada cambio se guarda solo, con un pequeño
 * retraso para no mandar un guardado por cada tilde que se toca seguido.
 */
export async function renderPermissionsAdminView(container) {
  const email = await getSignedInEmail();
  if (!isAdmin(email)) {
    navigate('/');
    return;
  }

  let permissions = await fetchPermissions();
  let saveTimer = null;

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await savePermissions(permissions);
        toast('Permisos guardados.');
      } catch (err) {
        console.error('No se pudieron guardar los permisos en Drive:', err);
        toast('No se pudo guardar en Drive — revisá tu conexión e intentá de nuevo.');
      }
    }, 800);
  }

  function paint() {
    const emails = Object.keys(permissions).sort();

    container.innerHTML = `
      <header class="app-header">
        <button class="icon-btn" id="btn-back" title="Volver">←</button>
        <span class="header-title">Administrar usuarios</span>
      </header>
      <main class="view-content">
        <p class="permissions-hint">Elegí qué módulos puede ver cada correo. Los cambios se guardan solos y le llegan al resto del equipo la próxima vez que abran la app.</p>
        ${emails.length ? `
          <section class="permissions-list">
            ${emails.map((e) => `
              <div class="permissions-row">
                <div class="permissions-row-top">
                  <div class="permissions-email">${escapeHTML(e)}</div>
                  <button type="button" class="icon-btn permissions-remove-btn" data-remove-email="${escapeHTML(e)}" title="Quitar usuario">🗑️</button>
                </div>
                <div class="permissions-checks">
                  ${APP_MODULES.map((m) => `
                    <label class="permissions-check">
                      <input type="checkbox" data-email="${escapeHTML(e)}" data-module="${m.id}" ${permissions[e]?.modules?.includes(m.id) ? 'checked' : ''} />
                      ${m.title}
                    </label>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </section>
        ` : `
          <div class="empty-state"><p>Todavía no agregaste a nadie.</p></div>
        `}
        <button type="button" class="btn btn-primary" id="btn-add-user">➕ Agregar usuario</button>
      </main>
    `;

    container.querySelector('#btn-back').addEventListener('click', () => navigate('/'));

    container.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const e = cb.dataset.email;
        const m = cb.dataset.module;
        if (!permissions[e]) permissions[e] = { modules: [] };
        const set = new Set(permissions[e].modules);
        if (cb.checked) set.add(m);
        else set.delete(m);
        permissions[e].modules = [...set];
        scheduleSave();
      });
    });

    container.querySelectorAll('.permissions-remove-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const target = btn.dataset.removeEmail;
        const ok = await confirmDialog(`¿Quitar a ${target}? Deja de ver todos los módulos hasta que lo agregues de nuevo.`);
        if (!ok) return;
        delete permissions[target];
        scheduleSave();
        paint();
      });
    });

    container.querySelector('#btn-add-user').addEventListener('click', async () => {
      const result = await promptDialog({
        title: 'Agregar usuario',
        fields: [{ name: 'email', label: 'Correo de Google', placeholder: 'nombre@gmail.com' }],
        confirmLabel: 'Agregar',
      });
      if (!result || !result.email) return;
      const newEmail = result.email.trim().toLowerCase();
      if (!newEmail.includes('@')) {
        toast('Ese correo no se ve válido.');
        return;
      }
      if (!permissions[newEmail]) permissions[newEmail] = { modules: [] };
      scheduleSave();
      paint();
    });
  }

  paint();
}
