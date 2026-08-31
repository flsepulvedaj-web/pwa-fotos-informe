// Lógica pura del dashboard de KPI del módulo Control — separada de la
// vista (controlObraView.js) para poder probarla sola, mismo patrón que
// aiAvance.js.
import { ssmaEntryTotal } from './db.js';

const DAY_MS = 86400000;

function todayLocalISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Historial de avance programado a partir de los snapshots subidos — SOLO
 * los de tipo 'real' (avance físico real en terreno): es el número de
 * verdad, no el objetivo. Los de tipo 'proyectada' no entran acá, solo
 * alimentan la Curva S (ver computeSCurve más abajo). Los snapshots de
 * antes de que existiera `scheduleType` (undefined) se tratan como 'real'. */
export function computeAvanceKPI(snapshots) {
  const real = snapshots.filter((s) => (s.scheduleType || 'real') === 'real');
  const sorted = [...real].sort((a, b) => a.uploadedAt - b.uploadedAt);
  return {
    latestPercent: sorted.length ? sorted[sorted.length - 1].overallPercent : null,
    history: sorted.map((s) => ({ date: s.uploadedAt, percent: s.overallPercent })),
  };
}

/** Curva S: el % de avance en el tiempo de cada tipo por separado, para
 * graficar Proyectada vs Física Real superpuestas — el gráfico estándar de
 * control de obra. */
export function computeSCurve(snapshots) {
  const byType = (type) => [...snapshots]
    .filter((s) => (s.scheduleType || 'real') === type)
    .sort((a, b) => a.uploadedAt - b.uploadedAt)
    .map((s) => ({ date: s.uploadedAt, percent: s.overallPercent }));
  return { proyectada: byType('proyectada'), real: byType('real') };
}

/** Historial de personal en obra (SSMA/personal) — últimos 14 días con datos. */
export function computePersonalKPI(ssmaEntries) {
  const sorted = [...ssmaEntries].sort((a, b) => a.date.localeCompare(b.date));
  const today = todayLocalISO();
  const todayEntry = sorted.find((e) => e.date === today);
  return {
    todayTotal: todayEntry ? ssmaEntryTotal(todayEntry) : null,
    history: sorted.slice(-14).map((e) => ({ date: e.date, total: ssmaEntryTotal(e) })),
  };
}

/**
 * % de cumplimiento del checklist en los últimos 30 días (ítems en "SI"
 * contra el total de ítems contestados, sin contar los N/A — el historial
 * completo de "No" queda igual guardado día por día, esto solo resume) +
 * la lista de "Pendientes": ítems que TODAVÍA NADIE CONTESTÓ (no los que
 * ya se marcaron "No" — un "No" ya es un dato registrado, no una tarea
 * pendiente; lo pendiente es completar el formulario).
 */
export function computeChecklistKPI(entries, types) {
  const typeTitleById = new Map(types.map((t) => [t.id, t.title]));
  const typeKeyById = new Map(types.map((t) => [t.id, t.key]));
  const cutoff = Date.now() - 30 * DAY_MS;

  let evaluated = 0;
  let cumplidos = 0;
  const incumplimientos = [];

  for (const entry of entries) {
    const entryTime = new Date(entry.date).getTime();
    entry.items.forEach((item, itemIndex) => {
      if (item.status && item.status !== 'N_A' && entryTime >= cutoff) {
        evaluated++;
        if (item.status === 'SI') cumplidos++;
      }
      if (!item.status) {
        incumplimientos.push({
          entryId: entry.id,
          itemIndex,
          typeTitle: typeTitleById.get(entry.checklistTypeId) || '—',
          typeKey: typeKeyById.get(entry.checklistTypeId) || '',
          date: entry.date,
          label: item.label,
          observacion: item.observacion || '',
        });
      }
    });
  }

  incumplimientos.sort((a, b) => b.date.localeCompare(a.date));

  return {
    cumplimientoPercent: evaluated > 0 ? Math.round((cumplidos / evaluated) * 100) : null,
    incumplimientos,
  };
}

/** Gráfico de línea simple en SVG (sin librería) — % de avance en el tiempo. */
export function renderLineChartSVG(points, { width = 300, height = 70 } = {}) {
  if (points.length < 2) return '';
  const stepX = width / (points.length - 1);
  const coords = points.map((p, i) => `${i * stepX},${height - (Math.min(100, p.percent) / 100) * height}`);
  const last = points[points.length - 1];
  const lastX = (points.length - 1) * stepX;
  const lastY = height - (Math.min(100, last.percent) / 100) * height;
  return `
    <svg viewBox="0 0 ${width} ${height + 18}" class="dashboard-chart" preserveAspectRatio="none">
      <polyline points="${coords.join(' ')}" fill="none" stroke="var(--color-primary)" stroke-width="2.5" vector-effect="non-scaling-stroke" />
      <circle cx="${lastX}" cy="${lastY}" r="4" fill="var(--color-primary)" />
      <text x="${width}" y="${height + 14}" font-size="11" fill="var(--color-text-muted)" text-anchor="end">último: ${last.percent}%</text>
    </svg>
  `;
}

/** Curva S en SVG (sin librería): 2 líneas superpuestas, Proyectada
 * (--color-primary) y Física Real (--color-accent), con leyenda chica. Si
 * a alguna de las 2 le falta historial (menos de 2 puntos) esa línea
 * simplemente no se dibuja — el gráfico igual sirve con una sola. */
export function renderSCurveChartSVG(proyectada, real, { width = 300, height = 90 } = {}) {
  if (proyectada.length < 2 && real.length < 2) return '';
  const chartH = height;
  function toPoints(series) {
    if (series.length < 2) return null;
    const stepX = width / (series.length - 1);
    return series.map((p, i) => `${i * stepX},${chartH - (Math.min(100, p.percent) / 100) * chartH}`).join(' ');
  }
  const proyectadaPoints = toPoints(proyectada);
  const realPoints = toPoints(real);
  const lastReal = real[real.length - 1];
  const lastProyectada = proyectada[proyectada.length - 1];

  return `
    <svg viewBox="0 0 ${width} ${chartH + 34}" class="dashboard-chart" preserveAspectRatio="none">
      ${proyectadaPoints ? `<polyline points="${proyectadaPoints}" fill="none" stroke="var(--color-primary)" stroke-width="2.5" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" />` : ''}
      ${realPoints ? `<polyline points="${realPoints}" fill="none" stroke="var(--color-accent)" stroke-width="2.5" vector-effect="non-scaling-stroke" />` : ''}
      <g font-size="10">
        <line x1="0" y1="${chartH + 14}" x2="14" y2="${chartH + 14}" stroke="var(--color-primary)" stroke-width="2.5" stroke-dasharray="4 3" />
        <text x="18" y="${chartH + 17}" fill="var(--color-text-muted)">Proyectada${lastProyectada ? ' ' + lastProyectada.percent + '%' : ''}</text>
        <line x1="140" y1="${chartH + 14}" x2="154" y2="${chartH + 14}" stroke="var(--color-accent)" stroke-width="2.5" />
        <text x="158" y="${chartH + 17}" fill="var(--color-text-muted)">Real${lastReal ? ' ' + lastReal.percent + '%' : ''}</text>
      </g>
    </svg>
  `;
}

/** Gráfico de barras simple en SVG — personal en obra en el tiempo. */
export function renderBarChartSVG(points, { width = 300, height = 70 } = {}) {
  if (points.length < 2) return '';
  const max = Math.max(...points.map((p) => p.total), 1);
  const gap = width / points.length;
  const barWidth = gap * 0.6;
  const bars = points
    .map((p, i) => {
      const barHeight = (p.total / max) * height;
      const x = i * gap + (gap - barWidth) / 2;
      const y = height - barHeight;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${Math.max(1, barHeight)}" fill="var(--color-accent)" rx="2" />`;
    })
    .join('');
  const last = points[points.length - 1];
  return `
    <svg viewBox="0 0 ${width} ${height + 18}" class="dashboard-chart" preserveAspectRatio="none">
      ${bars}
      <text x="${width}" y="${height + 14}" font-size="11" fill="var(--color-text-muted)" text-anchor="end">hoy: ${last.total}</text>
    </svg>
  `;
}

/** Tareas atrasadas del snapshot de programación más reciente. */
// `new Date('2026-08-20')` parsea como medianoche UTC, no hora local — en
// Chile eso cae la tarde/noche del día anterior, corriendo la comparación
// contra la medianoche local un día. Se arma con componentes locales.
function parseLocalDate(iso) {
  const [yyyy, mm, dd] = iso.split('-').map(Number);
  return new Date(yyyy, mm - 1, dd);
}

export function computeAtrasadas(snapshots) {
  const real = snapshots.filter((s) => (s.scheduleType || 'real') === 'real');
  const sorted = [...real].sort((a, b) => b.uploadedAt - a.uploadedAt);
  const latest = sorted[0];
  if (!latest) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return latest.tasks.filter((t) => t.plannedEnd && parseLocalDate(t.plannedEnd) < today && t.plannedPercent < 100);
}
