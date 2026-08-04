import { navigate } from '../router.js';

/**
 * Pantalla de inicio: elegir entre los módulos de la app. Es la primera
 * pantalla que se ve al abrir Len Reports.
 */
export async function renderHomeView(container) {
  container.innerHTML = `
    <div class="home-view">
      <header class="home-header">
        <img src="icons/icon-192.png" alt="" class="home-logo" />
        <h1>Len Reports</h1>
      </header>
      <main class="home-modules">
        <button type="button" class="module-card" id="module-fotos">
          <span class="module-icon">📷</span>
          <span class="module-title">Proyectos</span>
          <span class="module-desc">Fotos de obra → informe PDF</span>
        </button>
        <button type="button" class="module-card" id="module-protocolos">
          <span class="module-icon">📋</span>
          <span class="module-title">Protocolos</span>
          <span class="module-desc">Checklist de calidad + firma digital</span>
        </button>
      </main>
    </div>
  `;

  container.querySelector('#module-fotos').addEventListener('click', () => navigate('/fotos'));
  container.querySelector('#module-protocolos').addEventListener('click', () => navigate('/protocolos'));
}
