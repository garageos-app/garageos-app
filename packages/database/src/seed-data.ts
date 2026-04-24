import { InterventionTypeCategory } from '../prisma/generated/prisma/client/client.js';

// System-wide intervention types (tenant_id NULL). Visible to every
// tenant thanks to the intervention_types_isolation RLS policy. The
// shape stays in sync with InterventionType in schema.prisma.

export type SystemInterventionType = {
  code: string;
  nameIt: string;
  description: string;
  icon: string;
  category: InterventionTypeCategory;
  suggestsDeadline: boolean;
  defaultDeadlineMonths: number | null;
  defaultDeadlineKm: number | null;
};

export const SYSTEM_INTERVENTION_TYPES: SystemInterventionType[] = [
  {
    code: 'TAGLIANDO',
    nameIt: 'Tagliando',
    description: 'Tagliando periodico completo secondo piano manutenzione',
    icon: 'wrench',
    category: InterventionTypeCategory.maintenance,
    suggestsDeadline: true,
    defaultDeadlineMonths: 12,
    defaultDeadlineKm: 15000,
  },
  {
    code: 'CAMBIO_OLIO',
    nameIt: 'Cambio olio',
    description: 'Sostituzione olio motore e filtro',
    icon: 'droplet',
    category: InterventionTypeCategory.maintenance,
    suggestsDeadline: true,
    defaultDeadlineMonths: 12,
    defaultDeadlineKm: 15000,
  },
  {
    code: 'CAMBIO_GOMME_STAGIONE',
    nameIt: 'Cambio gomme stagionale',
    description: 'Inversione pneumatici estivi/invernali',
    icon: 'circle',
    category: InterventionTypeCategory.tires,
    suggestsDeadline: true,
    defaultDeadlineMonths: 6,
    defaultDeadlineKm: null,
  },
  {
    code: 'CAMBIO_GOMME_USURA',
    nameIt: 'Cambio gomme per usura',
    description: 'Sostituzione pneumatici per usura o danneggiamento',
    icon: 'circle',
    category: InterventionTypeCategory.tires,
    suggestsDeadline: false,
    defaultDeadlineMonths: null,
    defaultDeadlineKm: null,
  },
  {
    code: 'DISTRIBUZIONE',
    nameIt: 'Sostituzione cinghia distribuzione',
    description: 'Sostituzione cinghia/catena distribuzione e accessori',
    icon: 'settings',
    category: InterventionTypeCategory.maintenance,
    suggestsDeadline: true,
    defaultDeadlineMonths: null,
    defaultDeadlineKm: 120000,
  },
  {
    code: 'FRENI',
    nameIt: 'Intervento sistema frenante',
    description: 'Pastiglie, dischi, pinze, tubi freno',
    icon: 'disc',
    category: InterventionTypeCategory.repair,
    suggestsDeadline: false,
    defaultDeadlineMonths: null,
    defaultDeadlineKm: null,
  },
  {
    code: 'REVISIONE',
    nameIt: 'Revisione ministeriale',
    description: 'Revisione periodica obbligatoria per legge',
    icon: 'clipboard-check',
    category: InterventionTypeCategory.inspection,
    suggestsDeadline: true,
    defaultDeadlineMonths: 24,
    defaultDeadlineKm: null,
  },
  {
    code: 'CARROZZERIA',
    nameIt: 'Intervento carrozzeria',
    description: 'Riparazioni, verniciature, lattoneria',
    icon: 'paintbrush',
    category: InterventionTypeCategory.body,
    suggestsDeadline: false,
    defaultDeadlineMonths: null,
    defaultDeadlineKm: null,
  },
  {
    code: 'DIAGNOSI',
    nameIt: 'Diagnosi elettronica',
    description: 'Diagnosi centraline, lettura errori, riparazioni elettroniche',
    icon: 'activity',
    category: InterventionTypeCategory.repair,
    suggestsDeadline: false,
    defaultDeadlineMonths: null,
    defaultDeadlineKm: null,
  },
  {
    code: 'CLIMATIZZATORE',
    nameIt: 'Manutenzione climatizzatore',
    description: 'Ricarica gas, sanificazione, sostituzione filtri',
    icon: 'wind',
    category: InterventionTypeCategory.maintenance,
    suggestsDeadline: true,
    defaultDeadlineMonths: 24,
    defaultDeadlineKm: null,
  },
  {
    code: 'BATTERIA',
    nameIt: 'Sostituzione batteria',
    description: 'Sostituzione batteria di avviamento o di servizio',
    icon: 'battery',
    category: InterventionTypeCategory.repair,
    suggestsDeadline: false,
    defaultDeadlineMonths: null,
    defaultDeadlineKm: null,
  },
  {
    code: 'ALTRO',
    nameIt: 'Altro intervento',
    description: 'Intervento non classificato',
    icon: 'more-horizontal',
    category: InterventionTypeCategory.other,
    suggestsDeadline: false,
    defaultDeadlineMonths: null,
    defaultDeadlineKm: null,
  },
];
