import { navigate } from '../router.js';

/**
 * Pantalla de inicio del módulo Protocolos. Por ahora es un stub — se
 * completa con la lista de obras y el selector de plantillas en la
 * siguiente etapa.
 */
export async function renderProtocolHomeView(container) {
  container.innerHTML = `
    <div class="protocol-home-stub">
      <header class="app-header">
        <button class="icon-btn" id="btn-back-home" title="Volver al inicio">←</button>
        <span class="header-title">Protocolos</span>
      </header>
      <main class="view-content">
        <div class="empty-state">
          <p>Este módulo está en construcción.</p>
          <p>Muy pronto vas a poder llenar protocolos de calidad acá.</p>
        </div>
      </main>
    </div>
  `;

  container.querySelector('#btn-back-home').addEventListener('click', () => navigate('/'));
}
