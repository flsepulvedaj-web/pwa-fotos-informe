import { navigate } from '../router.js';
import { isSignedIn, signIn, signOut, getSignedInEmail } from '../googleDrive.js';
import { APP_MODULES, isAdmin, modulesForEmail, fetchPermissions, getCachedPermissions } from '../permissions.js';
import { toast } from '../utils.js';

const MODULE_ROUTES = { fotos: '/fotos', protocolos: '/protocolos', control: '/control' };
const MODULE_ICONS = { fotos: '📷', protocolos: '📋', control: '🎛️' };

/**
 * Pantalla de inicio: primero pide iniciar sesión con Google (así se sabe
 * quién es antes de mostrar nada — necesario para los permisos por
 * módulo), y después muestra solo los módulos a los que ese correo tiene
 * acceso. El admin ve todos + un acceso para administrar el resto.
 */
export async function renderHomeView(container) {
  if (!isSignedIn()) {
    renderLoginGate(container);
    return;
  }

  const email = await getSignedInEmail();
  if (!email) {
    // Token corrupto/inválido: se trata como no logueado.
    renderLoginGate(container);
    return;
  }

  const cached = getCachedPermissions();
  const hasCache = localStorage.getItem('control-permissions-cache-v1') !== null;

  if (hasCache || isAdmin(email)) {
    paintModules(container, email, cached);
    // Refresca en segundo plano — si cambió algo (Pancho te dio/sacó
    // acceso a un módulo), se repinta solo.
    fetchPermissions().then((fresh) => {
      if (JSON.stringify(fresh) !== JSON.stringify(cached)) paintModules(container, email, fresh);
    });
  } else {
    // Primera vez en este aparato y sin caché: esperamos la respuesta real
    // de Drive antes de pintar, para no mostrarle "sin acceso" a alguien
    // que sí tiene por unos segundos.
    container.innerHTML = `<div class="home-view"><p class="home-loading">Cargando tus módulos…</p></div>`;
    const fresh = await fetchPermissions();
    paintModules(container, email, fresh);
  }
}

function renderLoginGate(container) {
  container.innerHTML = `
    <div class="home-view">
      <header class="home-header">
        <img src="icons/icon-192.png" alt="" class="home-logo" />
        <h1>Vizor Reports</h1>
      </header>
      <p class="home-login-hint">Iniciá sesión con tu cuenta de Google para ver los módulos que tenés habilitados.</p>
      <button type="button" class="btn btn-primary" id="btn-login">Iniciar sesión con Google</button>
    </div>
  `;
  container.querySelector('#btn-login').addEventListener('click', async () => {
    try {
      await signIn();
      renderHomeView(container);
    } catch (err) {
      console.error(err);
      toast('No se pudo iniciar sesión con Google.');
    }
  });
}

function paintModules(container, email, permissions) {
  const allowed = modulesForEmail(email, permissions);
  const admin = isAdmin(email);
  const visibleModules = APP_MODULES.filter((m) => allowed.includes(m.id));

  container.innerHTML = `
    <div class="home-view">
      <header class="home-header">
        <img src="icons/icon-192.png" alt="" class="home-logo" />
        <h1>Vizor Reports</h1>
        ${admin ? '<button type="button" class="home-admin-link" id="btn-admin-users">⚙️ Administrar usuarios</button>' : ''}
      </header>
      ${visibleModules.length ? `
        <main class="home-modules">
          ${visibleModules.map((m) => `
            <button type="button" class="module-card" data-module="${m.id}">
              <span class="module-icon">${MODULE_ICONS[m.id]}</span>
              <span class="module-title">${m.title}</span>
              <span class="module-desc">${m.desc}</span>
            </button>
          `).join('')}
        </main>
      ` : `
        <div class="home-no-access">
          <p>Todavía no tenés acceso a ningún módulo.</p>
          <p>Pedile acceso a Pancho o a la Jessi.</p>
        </div>
      `}
      <button type="button" class="home-signout" id="btn-signout">${email} — Cerrar sesión</button>
    </div>
  `;

  container.querySelectorAll('.module-card').forEach((card) => {
    card.addEventListener('click', () => navigate(MODULE_ROUTES[card.dataset.module]));
  });

  container.querySelector('#btn-admin-users')?.addEventListener('click', () => navigate('/usuarios'));

  container.querySelector('#btn-signout').addEventListener('click', () => {
    signOut();
    renderHomeView(container);
  });
}
