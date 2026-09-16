// Cálculo de mercado por tipología y texto de defensa por reglas — mismas
// reglas que ya se aplicaron a mano en la sesión de Cowork (ver
// CONTEXTO.md): muestra = proyectos/refs (nunca usados) a ≤1 km, se
// amplía a ≤2 km si hay menos de 5; banda = percentil 25-75; nivel según
// cuánto se aleja la tasación de la mediana.

function percentile(sortedArr, p) {
  const v = sortedArr;
  const k = (v.length - 1) * p;
  const i = Math.floor(k);
  const j = Math.min(i + 1, v.length - 1);
  return v[i] + (v[j] - v[i]) * (k - i);
}

function median(arr) {
  const v = [...arr].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length ? (v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) : null;
}

/**
 * Elige el pool de muestras "en mercado" para una tipología: solo
 * `estado==='aprobada'` (nunca 'pendiente' ni 'descartada'), ≤1 km, o si
 * hay menos de 5 así, ≤2 km. Devuelve { pool, rule } — `rule` es el texto
 * que se muestra en la tarjeta ("Referencias a ≤1 km", etc).
 */
export function selectMarketPool(muestras, tipo) {
  const deTipo = muestras.filter((m) => m.estado === 'aprobada' && m.tipo === tipo && m.dist != null && m.ufm2 != null);
  let pool = deTipo.filter((m) => m.dist <= 1000);
  let rule = 'Referencias a ≤1 km';
  if (pool.length < 5) {
    pool = deTipo.filter((m) => m.dist <= 2000);
    rule = pool.length > deTipo.filter((m) => m.dist <= 1000).length
      ? 'Referencias a ≤2 km (a ≤1 km había menos de 5)'
      : rule;
  }
  return { pool, rule };
}

/**
 * Estadística de mercado de una tipología: mediana, banda P25-P75, n y el
 * pool usado (ids de muestra) — o null si no hay ninguna muestra aprobada
 * para esa tipología (nada que mostrar todavía).
 */
export function computeMarketStats(muestras, tipo) {
  const { pool, rule } = selectMarketPool(muestras, tipo);
  if (!pool.length) return null;
  const v = pool.map((m) => m.ufm2).sort((a, b) => a - b);
  return {
    n: v.length,
    med: round1(median(v)),
    p25: round1(percentile(v, 0.25)),
    p75: round1(percentile(v, 0.75)),
    min: round1(v[0]),
    max: round1(v[v.length - 1]),
    rule,
    // Nombrado `uids` (no `ids`) a propósito — así se llama en
    // tasacion-template.html (t.market.uids.includes(...)), que viene tal
    // cual de la sesión de Cowork sin tocar.
    uids: pool.map((m) => m.id),
  };
}

function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}

function pct(a, b) {
  // variación % de a respecto de b
  return b ? ((a / b - 1) * 100) : null;
}

/**
 * Nivel de defendibilidad + texto por reglas (no la prosa hecha a mano del
 * prototipo — algo genérico pero honesto, editable a mano por Pancho
 * después). `tasado`/`lista` son UF/m² promedio de la tipología (de
 * DEPTO). `market` es el resultado de computeMarketStats.
 */
export function buildDefenseText(tipo, tasado, lista, market) {
  if (!market) {
    return {
      level: 'sin-muestra',
      levelLabel: 'Sin muestra aprobada',
      title: `Todavía no hay muestras de mercado aprobadas para ${tipo}`,
      points: ['Agrega y aprueba al menos una referencia de esta tipología para poder calcular el mercado.'],
    };
  }
  const dT = pct(tasado, market.med);
  const dL = pct(lista, market.med);
  const inBand = tasado >= market.p25 && tasado <= market.p75;
  const fmt = (n, d = 1) => (n == null ? '—' : n.toFixed(d).replace('.', ','));
  const fmtPct = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${fmt(n, 1)}%`);

  let level, levelLabel;
  if (Math.abs(dT) <= 3) { level = 'solida'; levelLabel = 'Sólida'; }
  else if (Math.abs(dT) <= 7 || inBand) { level = 'defendible'; levelLabel = 'Defendible'; }
  else { level = 'debil'; levelLabel = 'Ojo'; }
  // Si la tasación queda BAJO el mercado (no es lo que Pancho quiere
  // mostrar), se marca "Ojo" igual aunque el % sea chico — es la alerta
  // más importante de todas.
  if (dT != null && dT < -3) { level = 'debil'; levelLabel = 'Ojo: bajo mercado'; }

  const points = [
    `Muestra de mercado: ${market.rule.toLowerCase()}. Mediana <b>${fmt(market.med)} UF/m²</b> (banda ${fmt(market.p25)}–${fmt(market.p75)}, n ${market.n}).`,
    `Lista del cliente: <b>${fmt(lista)}</b> → <b>${fmtPct(dL)}</b> sobre el mercado.`,
    `Tu tasación: <b>${fmt(tasado)}</b> → <b>${fmtPct(dT)}</b> vs mercado${inBand ? ' (dentro de la banda P25–P75)' : ' (fuera de la banda P25–P75)'}.`,
  ];
  if (lista > tasado) {
    const corrigePct = Math.min(100, ((lista - tasado) / (lista - market.med || 1)) * 100);
    points.push(`Tu corrección a la lista: <b>−${fmt((1 - tasado / lista) * 100, 1)}%</b>, descuenta ${fmt(corrigePct, 0)}% del sobreprecio del cliente sobre el mercado.`);
  }
  if (dT != null && dT < -3) {
    points.push('Ojo: tu tasación queda bajo la mediana de mercado — revisa si conviene subirla o si la muestra no representa bien tu unidad.');
  }

  const title = dL != null && dT != null
    ? `El cliente está ${fmtPct(dL)} sobre el mercado; tú, ${fmtPct(dT)}`
    : `${tipo}: comparación con el mercado`;

  return { level, levelLabel, title, points };
}
