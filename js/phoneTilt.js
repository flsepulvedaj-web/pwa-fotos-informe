// Detecta con el sensor de inclinación si el teléfono está físicamente
// horizontal. Sirve para teléfonos con el giro automático apagado o con el
// bloqueo de orientación (iPhone): ahí la pantalla se queda en vertical y el
// video de la cámara llega vertical aunque la persona sostenga el teléfono de
// lado. Con el giro automático activo la pantalla gira sola y esto no se usa.

const ORIENTATION_THRESHOLD = 0.7;
const FLAT_THRESHOLD = 0.85;

// Vector "arriba" del mundo expresado en los ejes del teléfono (x a la
// derecha, y hacia el borde superior), según la fórmula del estándar
// DeviceOrientation. Mismo signo en iPhone y Android.
export function upVectorFromEuler(betaDeg, gammaDeg) {
  const b = (betaDeg * Math.PI) / 180;
  const g = (gammaDeg * Math.PI) / 180;
  return { x: -Math.cos(b) * Math.sin(g), y: Math.sin(b), z: Math.cos(b) * Math.cos(g) };
}

// 'ccw': teléfono girado a la izquierda (borde derecho arriba).
// 'cw': girado a la derecha (borde izquierdo arriba).
// 'portrait': vertical. null: sin dato claro (boca arriba/abajo o en transición).
export function classifyTurn(up) {
  if (Math.abs(up.z) > FLAT_THRESHOLD) return null;
  if (Math.abs(up.x) > ORIENTATION_THRESHOLD) return up.x > 0 ? 'ccw' : 'cw';
  if (Math.abs(up.y) > ORIENTATION_THRESHOLD) return 'portrait';
  return null;
}

export function startPhoneTilt() {
  let turn = null;
  let gotReading = false;
  let listening = false;

  function onReading(e) {
    if (typeof e.beta !== 'number' || typeof e.gamma !== 'number') return;
    gotReading = true;
    const t = classifyTurn(upVectorFromEuler(e.beta, e.gamma));
    if (t) turn = t;
  }

  function listen() {
    if (listening) return;
    listening = true;
    window.addEventListener('deviceorientation', onReading);
  }

  // iOS exige pedir permiso desde un toque del usuario. Android no.
  async function request() {
    try {
      const DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === 'function') {
        const res = await DOE.requestPermission();
        if (res !== 'granted') return false;
      }
    } catch {
      return false;
    }
    listen();
    return true;
  }

  // Intento sin gesto (funciona en Android; en iPhone se pide al primer toque).
  if (!(window.DeviceOrientationEvent && typeof window.DeviceOrientationEvent.requestPermission === 'function')) {
    listen();
  }

  return {
    request,
    hasReading: () => gotReading,
    currentTurn: () => turn,
    stop() {
      window.removeEventListener('deviceorientation', onReading);
      listening = false;
    },
  };
}
