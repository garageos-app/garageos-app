// System-wide intervention types (tenant_id NULL). Visible to every
// tenant thanks to the intervention_types_isolation RLS policy. The
// shape stays in sync with InterventionType in schema.prisma.

export type SystemInterventionType = {
  code: string;
  nameIt: string;
  description: string;
  icon: string;
  suggestsDeadline: boolean;
  defaultDeadlineMonths: number | null;
  defaultDeadlineKm: number | null;
};

export const SYSTEM_INTERVENTION_TYPES: SystemInterventionType[] = [
  {
    code: 'MECCANICO',
    nameIt: 'Intervento Meccanico',
    description: 'Interventi di manutenzione e riparazione meccanica',
    icon: 'wrench',
    suggestsDeadline: true,
    defaultDeadlineMonths: 12,
    defaultDeadlineKm: 15000,
  },
  {
    code: 'GOMME',
    nameIt: 'Cambio Gomme',
    description: 'Pneumatici e servizi correlati',
    icon: 'circle',
    suggestsDeadline: true,
    defaultDeadlineMonths: 6,
    defaultDeadlineKm: null,
  },
  {
    code: 'REVISIONE',
    nameIt: 'Revisione',
    description: 'Revisione periodica e controlli',
    icon: 'clipboard-check',
    suggestsDeadline: true,
    defaultDeadlineMonths: 24,
    defaultDeadlineKm: null,
  },
];

export type SystemChecklistItem = {
  typeCode: string;
  code: string;
  nameIt: string;
  sortOrder: number;
};

export const SYSTEM_CHECKLIST_ITEMS: SystemChecklistItem[] = [
  // Intervento Meccanico
  { typeCode: 'MECCANICO', code: 'CAMBIO_OLIO', nameIt: 'Cambio olio', sortOrder: 10 },
  { typeCode: 'MECCANICO', code: 'FILTRO_OLIO', nameIt: 'Cambio filtro olio', sortOrder: 20 },
  { typeCode: 'MECCANICO', code: 'FILTRO_ARIA', nameIt: 'Cambio filtro aria', sortOrder: 30 },
  {
    typeCode: 'MECCANICO',
    code: 'FILTRO_ABITACOLO',
    nameIt: 'Cambio filtro abitacolo',
    sortOrder: 40,
  },
  { typeCode: 'MECCANICO', code: 'BATTERIA', nameIt: 'Sostituzione batteria', sortOrder: 50 },
  {
    typeCode: 'MECCANICO',
    code: 'DISTRIBUZIONE',
    nameIt: 'Sostituzione cinghia di distribuzione',
    sortOrder: 60,
  },
  { typeCode: 'MECCANICO', code: 'FRENI', nameIt: 'Intervento impianto frenante', sortOrder: 70 },
  { typeCode: 'MECCANICO', code: 'CLIMA', nameIt: 'Manutenzione climatizzatore', sortOrder: 80 },
  { typeCode: 'MECCANICO', code: 'DIAGNOSI', nameIt: 'Diagnosi elettronica', sortOrder: 90 },
  // Cambio Gomme
  { typeCode: 'GOMME', code: 'PNEUMATICI', nameIt: 'Sostituzione pneumatici', sortOrder: 10 },
  { typeCode: 'GOMME', code: 'STAGIONALE', nameIt: 'Cambio gomme stagionale', sortOrder: 20 },
  { typeCode: 'GOMME', code: 'CONVERGENZA', nameIt: 'Convergenza', sortOrder: 30 },
  { typeCode: 'GOMME', code: 'EQUILIBRATURA', nameIt: 'Equilibratura', sortOrder: 40 },
  { typeCode: 'GOMME', code: 'RIPARAZIONE', nameIt: 'Riparazione foratura', sortOrder: 50 },
  // Revisione
  { typeCode: 'REVISIONE', code: 'MINISTERIALE', nameIt: 'Revisione ministeriale', sortOrder: 10 },
  {
    typeCode: 'REVISIONE',
    code: 'PRE_REVISIONE',
    nameIt: 'Pre-revisione / controllo',
    sortOrder: 20,
  },
];
