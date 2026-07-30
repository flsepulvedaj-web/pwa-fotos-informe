// Formatos oficiales de informe "Fotografías Desarrollo de Obras". Cada uno
// define, para las 8 posiciones de una página (se repite si hay más de 8
// fotos), si el casillero lleva un texto FIJO o si es LIBRE (el usuario
// escribe la descripción, como en el formato original).
//
// slotLabels === null        -> las 8 posiciones son libres (formato "libre").
// slotLabels[i] === null      -> esa posición es libre.
// slotLabels[i] === 'texto'    -> esa posición siempre lleva ese texto fijo.

export const REPORT_FORMATS = [
  {
    id: 'libre',
    label: 'Título libre (una descripción por foto)',
    slotLabels: null,
  },
  {
    id: 'casas-avance',
    label: 'Casas: más avanzada / menos avanzada',
    slotLabels: [
      null, null,
      'Casa con más avance', 'Casa con más avance', 'Casa con más avance',
      'Casa con menos avance', 'Casa con menos avance', 'Casa con menos avance',
    ],
  },
  {
    id: 'casas-iguales',
    label: 'Casas: todas el mismo avance',
    slotLabels: [
      null, null,
      'Casas todas el mismo avance', 'Casas todas el mismo avance',
      'Casas todas el mismo avance', 'Casas todas el mismo avance',
      'Casas todas el mismo avance', 'Casas todas el mismo avance',
    ],
  },
  {
    id: 'depto-avance',
    label: 'Departamentos: más avanzado / menos avanzado',
    slotLabels: [
      null, null,
      'Depto más avanzado', 'Depto más avanzado', 'Depto más avanzado',
      'Depto menos avanzado', 'Depto menos avanzado', 'Depto menos avanzado',
    ],
  },
  {
    id: 'depto-iguales',
    label: 'Departamentos: todos el mismo avance',
    slotLabels: [
      null, null,
      'Depto todos el mismo avance', 'Depto todos el mismo avance',
      'Depto todos el mismo avance', 'Depto todos el mismo avance',
      'Depto todos el mismo avance', 'Depto todos el mismo avance',
    ],
  },
  {
    id: 'subterraneo',
    label: 'Subterráneo',
    slotLabels: Array(8).fill('Subterráneo'),
  },
];

export function getFormatById(id) {
  return REPORT_FORMATS.find((f) => f.id === id) || REPORT_FORMATS[0];
}

/** Texto fijo para la posición (0-based) dentro de un bloque de 8, o null si es libre. */
export function fixedLabelFor(format, indexInPage) {
  if (!format.slotLabels) return null;
  return format.slotLabels[indexInPage] ?? null;
}
