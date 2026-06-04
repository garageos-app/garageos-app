// Mirrors the GET /v1/me/deadlines response shape (raw Prisma select →
// camelCase, no serializer). BR-100: a deadline always has a date OR a km
// criterion, so dueDate may be null when dueOdometerKm is set.
export type MeDeadline = {
  id: string;
  vehicleId: string;
  interventionTypeId: string;
  sourceInterventionId: string | null;
  dueDate: string | null;
  dueOdometerKm: number | null;
  description: string | null;
  isRecurring: boolean;
  recurringMonths: number | null;
  recurringKm: number | null;
  status: 'open' | 'overdue' | 'completed' | 'cancelled' | (string & {});
  completedByInterventionId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  vehicle: { id: string; plate: string; make: string; model: string };
  interventionType: { id: string; code: string; nameIt: string };
};

export type MeDeadlinesResponse = {
  deadlines: MeDeadline[];
  nextCursor: string | null;
};
