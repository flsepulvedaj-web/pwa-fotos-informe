// Valores por defecto del módulo Control de calidad. Nada de esto está fijo a
// un cliente: se carga al crear un proyecto y después se edita en la pestaña
// Catálogos de ese proyecto.
import { CHILE_HOLIDAYS } from './qcDates.js';
import { qcNewId } from './qcStore.js';

export const QC_ROLES = [
  { id: 'responsable', label: 'Responsable del proyecto' },
  { id: 'revisor', label: 'Revisor' },
  { id: 'asesor', label: 'Asesor' },
  { id: 'revisado', label: 'Revisado (diseñador o contratista)' },
  { id: 'mandante', label: 'Mandante (solo lectura)' },
  // Segunda firma opcional para aprobaciones de mayor impacto.
  { id: 'gobernanza', label: 'Gobernanza (segunda firma)' },
];

export function roleLabel(id) {
  return QC_ROLES.find((r) => r.id === id)?.label || id || '';
}

// `bloquea` define cuándo una observación de esa categoría impide aprobar la
// entrega: 'abiertas' (mientras esté abierta), 'sin_solucion' (hasta que esté
// corregida o con solución acordada) o 'no'.
export const DEFAULT_CATEGORIAS = [
  { codigo: 'A', nombre: 'Crítica', descripcion: 'Incumplimiento de requisitos del mandante, de la normativa, de seguridad, del programa o del presupuesto.', tratamiento: 'Impide recomendar la aprobación. Debe resolverse antes de cerrar la etapa.', bloquea: 'abiertas' },
  { codigo: 'B', nombre: 'Mayor', descripcion: 'Falta de coordinación entre especialidades, información incompleta o inconsistencias entre documentos.', tratamiento: 'Debe corregirse en la re-entrega de la misma etapa.', bloquea: 'sin_solucion' },
  { codigo: 'C', nombre: 'Menor', descripcion: 'Aspectos de forma, rotulación o presentación que no afectan la solución técnica.', tratamiento: 'Puede corregirse en la etapa siguiente, con seguimiento en la matriz.', bloquea: 'no' },
];

export const DEFAULT_ESPECIALIDADES = ['Arquitectura', 'Estructura', 'Electricidad', 'Climatización', 'Incendio', 'Sanitarias', 'Corrientes débiles', 'Seguridad', 'BIM', 'Costos', 'Permisos'];

export const DEFAULT_ESTADOS_ENTREGA = ['Recibida', 'Devuelta (incompleta)', 'En revisión', 'Con observaciones', 'Re-entrega recibida', 'Recomendada para aprobación', 'Aprobada'];

export const DEFAULT_ESTADOS_OBSERVACION = ['Abierta', 'Respondida', 'En verificación', 'Cerrada'];

export const DEFAULT_TIPOS_PROYECTO = ['Revisión de diseño', 'Revisión de proyecto', 'Otro'];

export const TEMPLATES = [
  { id: 'plan', label: 'Cargar un plan de control de calidad (Word)', desc: 'Lee las etapas, actividades, roles y categorías del documento.' },
  {
    id: 'generica',
    label: 'Revisión de proyecto genérica',
    desc: 'Anteproyecto, proyecto de arquitectura, de especialidades y definitivo.',
    etapas: ['Anteproyecto', 'Proyecto de arquitectura', 'Proyecto de especialidades', 'Proyecto definitivo'],
  },
  { id: 'blanco', label: 'En blanco', desc: 'Para armar el proyecto desde cero.', etapas: [] },
];

/** Operaciones que crean los catálogos de un proyecto (con valores propios si vienen del plan). */
export function catalogOps(overrides = {}) {
  const catalogs = {
    categorias: DEFAULT_CATEGORIAS,
    especialidades: DEFAULT_ESPECIALIDADES.map((nombre) => ({ nombre })),
    estadosEntrega: DEFAULT_ESTADOS_ENTREGA,
    estadosObservacion: DEFAULT_ESTADOS_OBSERVACION,
    tiposProyecto: DEFAULT_TIPOS_PROYECTO,
    feriados: CHILE_HOLIDAYS,
    indicadores: [],
    procesoRevision: [],
    ...overrides,
  };
  return Object.entries(catalogs).map(([id, items]) => ({ op: 'set', table: 'catalogos', id, patch: { items } }));
}

/** Etapas de las plantillas simples (genérica / en blanco). */
export function templateStageOps(templateId) {
  const template = TEMPLATES.find((t) => t.id === templateId);
  return (template?.etapas || []).map((nombre, i) => ({
    op: 'set',
    table: 'etapas',
    id: qcNewId(),
    patch: { codigo: String(i + 1), nombre, orden: i + 1, plazoRevisionDias: 10, fechaRecepcion: null },
  }));
}
