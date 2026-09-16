// UF de hoy, para tasar en UF las muestras que se agreguen en pesos —
// mindicador.cl (API pública chilena, gratis, sin llave). Si falla (sin
// internet, la API caída), devuelve null: el llamador debe dejar el campo
// editable para que Pancho la escriba a mano — nunca bloquea nada.

export async function fetchUFHoy() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch('https://mindicador.cl/api/uf', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const serie = data?.serie?.[0];
    if (!serie || typeof serie.valor !== 'number') return null;
    return { valor: serie.valor, fecha: serie.fecha.slice(0, 10) };
  } catch (err) {
    console.error('No se pudo obtener la UF de hoy (mindicador.cl):', err);
    return null;
  }
}
