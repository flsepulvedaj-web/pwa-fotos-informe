// Plantillas de checklist diario del módulo Control, extraídas del formato
// Excel real que usa el equipo ("CHECK DIARIO FILE 297 CHILLAN") — mismo
// vocabulario de estados y misma estructura de 3 checklists por día.
//
// SSMA y Programación son prácticamente iguales en todas las obras (temas
// administrativos/de seguridad, no dependen de la etapa constructiva).
// Faenas Diarias sí cambia según la obra y su etapa (acá se dejan los
// ítems del ejemplo real como punto de partida) — todos los ítems, de los
// 3 tipos, son editables desde la app por obra.

export const CHECKLIST_STATUS = [
  { id: 'SI', label: 'SI' },
  { id: 'NO_ENTREGADO', label: 'No entregado' },
  { id: 'INCOMPLETO', label: 'Incompleto' },
  { id: 'N_A', label: 'N/A' },
  { id: 'EN_REVISION', label: 'En revisión' },
  { id: 'NO_LO_TIENEN', label: 'No lo tienen' },
];

export const DEFAULT_CHECKLIST_TYPES = [
  {
    key: 'ssma',
    title: 'SSMA',
    items: [
      { label: 'Charla diaria de seguridad realizada', nota: 'ITO LEN - Asistir y solicitar registro a Constructora y subir a carpeta' },
      { label: 'Registro de asistencia a charla diaria', nota: 'Solicitar registro a Constructora y subir a carpeta' },
      { label: 'Revisión AT (Autorización de Trabajo)', nota: 'Solicitar registro a Constructora y subir a carpeta' },
      { label: 'Revisión de ART (Autorización de Riesgo de Trabajo)', nota: 'Solicitar registro a Constructora y subir a carpeta' },
      { label: 'Verificación uso correcto de EPP', nota: 'Inspeccionar ITO LEN (foto respaldo en carpeta)' },
      { label: 'Revisión señalización de seguridad', nota: 'Inspeccionar ITO LEN (foto respaldo en carpeta)' },
      { label: 'Orden y limpieza del área de trabajo', nota: 'Inspeccionar ITO LEN (foto respaldo en carpeta)' },
      { label: 'Control de accesos y delimitación de zonas', nota: 'Inspeccionar ITO LEN (foto respaldo en carpeta)' },
      { label: 'Registro de incidentes / cuasi incidentes', nota: 'Activar cascada de emergencia cuando ocurra (seguir protocolo y subir registro a Smartsheet)' },
      { label: 'Confirmar condiciones inseguras', nota: 'Inspeccionar ITO LEN (foto respaldo en carpeta)' },
      { label: 'Registro fotográfico subido a la carpeta', nota: 'ITO LEN' },
      { label: 'Rechequeo, en 2 sesiones diarias, de las condiciones de seguridad a horas distintas', nota: 'Inspeccionar ITO LEN (foto respaldo en carpeta en caso de evidenciar alguna falta)' },
    ],
  },
  {
    key: 'faenas',
    title: 'Faenas Diarias',
    items: [
      { label: 'Actualización de Tareas Diarias', nota: 'Inspeccionar ITO LEN' },
      { label: 'Revisión de Excavación para descenso de nuevos estanques', nota: 'Inspeccionar ITO LEN (foto respaldo en carpeta)' },
      { label: 'Revisión de estabilidad de excavaciones (material suelto)', nota: 'Inspeccionar ITO LEN (foto respaldo en carpeta)' },
      { label: 'Control de Interferencias', nota: 'Inspeccionar ITO LEN (foto respaldo en carpeta)' },
      { label: 'Control de Sello de excavaciones', nota: 'Inspeccionar ITO LEN (foto respaldo en carpeta)' },
      { label: 'Revisión de Losa demolida', nota: 'Solicitar registro a Constructora' },
      { label: 'Control retiro y disposición de escombros', nota: 'Inspeccionar ITO LEN (foto respaldo en carpeta)' },
      { label: 'Revisión de Planimetría General e interferencias', nota: 'ITO LEN revisar planos diariamente y ver interferencias en terreno. Si hay interferencia, hablar con el Coordinador.' },
    ],
  },
  {
    key: 'programacion',
    title: 'Programación',
    items: [
      { label: 'Revisión de Programa de Obra', nota: 'ITO LEN — en caso de no cumplir, ir registrando. Notificar solo semanalmente (atrasos mayores a 20 días son muy graves)' },
      { label: 'Revisión de Reprogramación en caso de existir', nota: 'ITO LEN' },
      { label: 'Revisión Técnica de Planimetrías', nota: 'ITO LEN — ver si están acorde a lo último solicitado' },
      { label: 'Registro fotográfico de avance diario subido a la carpeta', nota: 'ITO LEN — fotos de avance de obra' },
      { label: 'Revisión de Cuadrillas y suficiencia de Personal', nota: 'ITO LEN — informar en caso de insuficiencia' },
      { label: 'Revisión de Materiales y suficiencia de ellos', nota: 'ITO LEN — coordinación con jefe de obra, informar en caso de insuficiencia' },
      { label: 'Actualización Diaria Smartsheet', nota: 'ITO LEN: programación / avances de obra / registro fotográfico / HH / otros' },
      { label: 'Solicitar RDI, en caso de existir', nota: 'ITO LEN — solicitar a Constructora, revisar y subir a Smartsheet' },
    ],
  },
];
