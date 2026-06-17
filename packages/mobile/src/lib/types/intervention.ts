// Mirror of GET /v1/me/interventions/:id (api/mobile share no package).
export type DisputeReasonCategory = 'not_performed' | 'wrong_data' | 'not_authorized' | 'other';
export type DisputeStatus =
  | 'open'
  | 'responded'
  | 'resolved_by_cancellation'
  | 'escalated'
  | 'closed_by_admin';

export type Dispute = {
  id: string;
  reasonCategory: DisputeReasonCategory;
  customerDescription: string;
  status: DisputeStatus;
  createdAt: string;
  tenantResponse: string | null;
  tenantResponseAt: string | null;
  resolvedAt: string | null;
};

export type PartReplaced = {
  name: string;
  code: string | null;
  quantity: number;
  notes: string | null;
};

export type GeneratedDeadline = {
  id: string;
  type: { code: string; name_it: string };
  dueDate: string | null;
  dueOdometerKm: number | null;
  description: string | null;
  status: string;
};

export type ShopInterventionDetail = {
  intervention: {
    id: string;
    vehicleId: string;
    interventionDate: string;
    odometerKm: number;
    type: { code: string; name_it: string };
    title: string | null;
    description: string;
    partsReplaced: PartReplaced[];
    partsReplacedCount: number;
    status: string;
    isDisputed: boolean;
    tenant: { businessName: string; locationCity: string | null };
    attachmentsCount: number;
    generatedDeadlines: GeneratedDeadline[];
  };
  disputes: Dispute[];
};

export type CreateDisputeBody = {
  reasonCategory: DisputeReasonCategory;
  description: string;
};
