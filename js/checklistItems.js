// Cómo se juntan las preguntas VIGENTES de un tipo de checklist (SSMA, Faenas,
// Programación) con las respuestas guardadas de un día. Lo usan la pantalla del
// checklist y el panel de "Pendientes" del dashboard, para que los dos vean
// exactamente lo mismo.

/** Compara textos de pregunta: tolera mayúsculas y espacios de más. */
export function sameLabel(a, b) {
  const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return !!a && !!b && norm(a) === norm(b);
}

const contestada = (it) => !!it && (it.status != null || !!it.observacion || !!it.resolved);

/**
 * Junta, por `itemId`, el texto VIGENTE de la plantilla (label/nota — lo que se
 * está preguntando ahora) con la RESPUESTA guardada de ese día (status /
 * observacion / resolved). Recorre `type.items` (no `entry.items`): el orden y
 * el conjunto de preguntas es siempre el de la plantilla actual.
 *
 * El id de una pregunta no es 100% estable: cada teléfono generaba sus propios
 * ids para "la misma" pregunta (la lista de SSMA nunca se subió a Drive), y lo
 * que contestaba Sergio quedaba guardado con SUS ids y sin el texto de la
 * pregunta, así que a Pancho le aparecía como "sin contestar". Por eso:
 *  1. Se busca por id y, si no, por TEXTO (si hay varias, manda la contestada).
 *  2. Rescate de registros viejos: si quedaron respuestas con id desconocido y
 *     sin texto, y son EXACTAMENTE tantas como preguntas sin contestar, y todas
 *     dicen lo mismo (ej. todo "SI"), se asignan por orden. Si no, no se adivina:
 *     atribuir mal un "NO" sería peor que dejarlo pendiente.
 */
export function mergeEntryItemsWithTemplate(type, entry) {
  const templateIds = new Set(type.items.map((t) => t.itemId ?? t.id));
  const usados = new Set();

  const filas = type.items.map((templateItem) => {
    const itemId = templateItem.itemId ?? templateItem.id;
    const candidatos = entry.items.filter((it) => it.itemId === itemId || sameLabel(it.label, templateItem.label));
    const stored = candidatos.find(contestada) || candidatos.find((it) => it.itemId === itemId) || candidatos[0];
    candidatos.forEach((c) => usados.add(c));
    return { templateItem, itemId, stored };
  });

  // Rescate de respuestas huérfanas (ver arriba).
  const huerfanas = entry.items.filter((it) => !usados.has(it) && !templateIds.has(it.itemId) && !(it.label || '').trim() && it.status != null);
  const sinContestar = filas.filter((f) => !contestada(f.stored));
  if (huerfanas.length && huerfanas.length === sinContestar.length) {
    // Basta con que todas tengan el mismo estado (así el día queda bien completo o no);
    // una observación escrita se queda con la pregunta que le toca por orden.
    const mismoEstado = huerfanas.every((h) => h.status === huerfanas[0].status);
    if (mismoEstado) sinContestar.forEach((f, i) => { f.stored = huerfanas[i]; });
  }

  return filas.map(({ templateItem, itemId, stored }) => ({
    itemId,
    label: templateItem.label,
    nota: templateItem.nota || '',
    status: stored?.status ?? null,
    resolved: stored?.resolved ?? false,
    observacion: stored?.observacion || '',
    // ¿Ese día ya tenía esta pregunta? Si se agregó a la lista DESPUÉS, el día viejo
    // la muestra sin contestar, pero no es un incumplimiento (el panel de Pendientes lo usa).
    existiaEnRegistro: !!stored,
  }));
}
