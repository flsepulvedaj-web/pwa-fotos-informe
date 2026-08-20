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

/** Historial de avance programado a partir de los snapshots subidos. */
export function computeAvanceKPI(snapshots) {
  const sorted = [...snapshots].sort((a, b) => a.uploadedAt - b.uploadedAt);
  return {
    latestPercent: sorted.length ? sorted[sorted.length - 1].overallPercent : null,
    history: sorted.map((s) => ({ date: s.uploadedAt, percent: s.overallPercent })),
  };
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
 * contra el total de ítems marcados, sin contar los N/A) + la lista de
 * incumplimientos abiertos (cualquier ítem que no haya quedado en SI/N-A y
 * todavía no se marcó resuelto), de cualquier fecha — no solo 30 días,
 * porque un incumplimiento sigue abierto hasta que alguien lo resuelva.
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
      if (!item.status || item.status === 'N_A') return;
      if (entryTime >= cutoff) {
        evaluated++;
        if (item.status === 'SI') cumplidos++;
      }
      if (item.status !== 'SI' && !item.resolved) {
        incumplimientos.push({
          entryId: entry.id,
          itemIndex,
          typeTitle: typeTitleById.get(entry.checklistTypeId) || '—',
          typeKey: typeKeyById.get(entry.checklistTypeId) || '',
          date: entry.date,
          label: item.label,
          status: item.status,
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
  const sorted = [...snapshots].sort((a, b) => b.uploadedAt - a.uploadedAt);
  const latest = sorted[0];
  if (!latest) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return latest.tasks.filter((t) => t.plannedEnd && parseLocalDate(t.plannedEnd) < today && t.plannedPercent < 100);
}
