import { navigate } from '../router.js';
import { isSignedIn, signIn, signOut, getSignedInEmail } from '../googleDrive.js';
import { APP_MODULES, isAdmin, modulesForEmail, fetchPermissions, getCachedPermissions } from '../permissions.js';
import { toast } from '../utils.js';

// Ícono propio (engranaje + lápiz) para "Proyectos" en vez de una carpeta
// genérica — Pancho lo pidió explícitamente ("no me gusta que sea una
// carpeta"). El engranaje va en el naranja de la marca; el lápiz usa
// var(--color-text) para que se vea bien en modo claro y oscuro (un navy
// fijo casi desaparecía contra la tarjeta en modo oscuro).
const PROYECTOS_ICON = `
  <svg viewBox="0 0 100 100" width="34" height="34" class="hub-icon-svg" aria-hidden="true">
    <g transform="translate(50,50)">
      <rect x="-3.5" y="-40" width="7" height="12" rx="1" fill="#FF4A00"/>
      <rect x="-3.5" y="-40" width="7" height="12" rx="1" fill="#FF4A00" transform="rotate(45)"/>
      <rect x="-3.5" y="-40" width="7" height="12" rx="1" fill="#FF4A00" transform="rotate(90)"/>
      <rect x="-3.5" y="-40" width="7" height="12" rx="1" fill="#FF4A00" transform="rotate(135)"/>
      <rect x="-3.5" y="-40" width="7" height="12" rx="1" fill="#FF4A00" transform="rotate(180)"/>
      <rect x="-3.5" y="-40" width="7" height="12" rx="1" fill="#FF4A00" transform="rotate(225)"/>
      <rect x="-3.5" y="-40" width="7" height="12" rx="1" fill="#FF4A00" transform="rotate(270)"/>
      <rect x="-3.5" y="-40" width="7" height="12" rx="1" fill="#FF4A00" transform="rotate(315)"/>
      <circle cx="0" cy="0" r="30" fill="#FF4A00"/>
      <circle cx="0" cy="0" r="15" fill="var(--color-surface)"/>
      <g transform="rotate(45)">
        <rect x="-5" y="-46" width="10" height="63" rx="1.5" fill="var(--color-text)"/>
        <polygon points="-5,17 5,17 0,34" fill="var(--color-text)"/>
        <rect x="-5" y="-51" width="10" height="7" rx="1.5" fill="#FF4A00"/>
      </g>
    </g>
  </svg>
`;

// Home ya no muestra los módulos reales directo — muestra 2 "macro
// módulos" (Banco / Proyectos) que agrupan los módulos con permiso propio
// + placeholders "Próximamente" sin desarrollar todavía.
const HUBS = [
  { id: 'banco', route: '/banco', icon: '🏦', title: 'Banco', desc: 'Avance de obra, informes técnicos y research', modules: ['fotos'] },
  { id: 'proyectos', route: '/proyectos', icon: PROYECTOS_ICON, title: 'Proyectos', desc: 'Protocolos, Control y zonificación', modules: ['protocolos', 'control'] },
];

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
  const visibleHubs = HUBS.filter((h) => h.modules.some((m) => allowed.includes(m)));

  container.innerHTML = `
    <div class="home-view">
      <header class="home-header">
        <img src="icons/icon-192.png" alt="" class="home-logo" />
        <h1>Vizor Reports</h1>
        ${admin ? '<button type="button" class="home-admin-link" id="btn-admin-users">⚙️ Administrar usuarios</button>' : ''}
      </header>
      ${visibleHubs.length ? `
        <main class="home-modules">
          ${visibleHubs.map((h) => `
            <button type="button" class="module-card" data-hub="${h.id}">
              <span class="module-icon">${h.icon}</span>
              <span class="module-title">${h.title}</span>
              <span class="module-desc">${h.desc}</span>
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
    const hub = HUBS.find((h) => h.id === card.dataset.hub);
    card.addEventListener('click', () => navigate(hub.route));
  });

  container.querySelector('#btn-admin-users')?.addEventListener('click', () => navigate('/usuarios'));

  container.querySelector('#btn-signout').addEventListener('click', () => {
    signOut();
    renderHomeView(container);
  });
}
