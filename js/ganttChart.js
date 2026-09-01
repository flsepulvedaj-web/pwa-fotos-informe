// Carta Gantt visual (barras en el tiempo, como en Project) a partir del
// mismo árbol de tareas que ya arma buildTaskTree (controlScheduleParser.js)
// — se construye con HTML/CSS, no SVG, para que el texto de cada tarea se
// vea nítido con cualquier zoom y para reusar los estilos de texto del
// resto de la app. Sin líneas de dependencia (el CSV/Excel de Project que
// lee el parser no trae esa info) ni edición — es una vista de solo
// lectura, el dato de verdad sigue siendo la tabla de al lado.
import { escapeHTML } from './utils.js';

const PX_PER_DAY = 14; // ancho mínimo legible por día — más angosto y las barras cortas desaparecen

function parseLocalDate(iso) {
  if (!iso) return null;
  const [yyyy, mm, dd] = iso.split('-').map(Number);
  return new Date(yyyy, mm - 1, dd);
}

function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

function monthLabelEs(date) {
  const label = date.toLocaleDateString('es-CL', { month: 'short', year: '2-digit' });
  return label.charAt(0).toUpperCase() + label.slice(1).replace('.', '');
}

/** Aplana el árbol respetando qué nodos están colapsados — mismas filas
 * visibles que la tabla de al lado, así las 2 vistas muestran lo mismo y
 * se pueden colapsar partidas para achicar el gráfico. */
function flattenVisible(nodes, depth, collapsedSet, out) {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.children.length && !collapsedSet.has(node.index)) {
      flattenVisible(node.children, depth + 1, collapsedSet, out);
    }
  }
  return out;
}

/**
 * Devuelve el HTML de la Carta Gantt, o null si no hay ninguna tarea con
 * fecha de inicio Y fin para poder ubicarla en el tiempo.
 */
export function renderGanttChartHTML(tree, collapsedSet) {
  const rows = flattenVisible(tree, 0, collapsedSet, []);
  const withDates = rows.filter((r) => r.node.task.plannedStart && r.node.task.plannedEnd);
  if (!withDates.length) return null;

  const starts = withDates.map((r) => parseLocalDate(r.node.task.plannedStart).getTime());
  const ends = withDates.map((r) => parseLocalDate(r.node.task.plannedEnd).getTime());
  const minDate = new Date(Math.min(...starts));
  const maxDate = new Date(Math.max(...ends));
  const timelineWidth = Math.max(PX_PER_DAY, daysBetween(minDate, maxDate) * PX_PER_DAY);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayX = today >= minDate && today <= maxDate ? daysBetween(minDate, today) * PX_PER_DAY : null;

  // Una marca vertical + etiqueta al 1° de cada mes que cae dentro del rango.
  const monthTicks = [];
  const cursor = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
  while (cursor <= maxDate) {
    const x = daysBetween(minDate, cursor) * PX_PER_DAY;
    if (x >= 0) monthTicks.push({ x, label: monthLabelEs(cursor) });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const labelsHTML = rows
    .map(({ node, depth }) => `<div class="gantt-label" style="padding-left:${depth * 14 + 8}px" title="${escapeHTML(node.task.name)}">${escapeHTML(node.task.name)}</div>`)
    .join('');

  const barsHTML = rows
    .map(({ node }) => {
      const { task } = node;
      if (!task.plannedStart || !task.plannedEnd) return `<div class="gantt-row"></div>`;
      const start = parseLocalDate(task.plannedStart);
      const end = parseLocalDate(task.plannedEnd);
      const x = daysBetween(minDate, start) * PX_PER_DAY;
      const spanDays = daysBetween(start, end);
      const titleAttr = `${escapeHTML(task.name)} — ${task.plannedPercent}%`;
      if (spanDays === 0) {
        return `<div class="gantt-row"><div class="gantt-milestone" style="left:${x}px" title="${titleAttr}"></div></div>`;
      }
      const w = Math.max(4, spanDays * PX_PER_DAY);
      const fillPct = Math.max(0, Math.min(100, task.plannedPercent));
      const summaryClass = node.children.length ? ' gantt-bar-summary' : '';
      return `
        <div class="gantt-row">
          <div class="gantt-bar${summaryClass}" style="left:${x}px;width:${w}px" title="${titleAttr}">
            <div class="gantt-bar-fill" style="width:${fillPct}%"></div>
          </div>
        </div>
      `;
    })
    .join('');

  return `
    <div class="gantt-wrap">
      <div class="gantt-labels">
        <div class="gantt-label-header"></div>
        ${labelsHTML}
      </div>
      <div class="gantt-scroll">
        <div class="gantt-timeline" style="width:${timelineWidth}px">
          <div class="gantt-header">
            ${monthTicks.map((t) => `<div class="gantt-month-tick" style="left:${t.x}px">${t.label}</div>`).join('')}
          </div>
          <div class="gantt-body">
            ${monthTicks.map((t) => `<div class="gantt-gridline" style="left:${t.x}px"></div>`).join('')}
            ${todayX !== null ? `<div class="gantt-today-line" style="left:${todayX}px" title="Hoy"></div>` : ''}
            ${barsHTML}
          </div>
        </div>
      </div>
    </div>
  `;
}
