import type { Prisma } from '@garageos/database';

// Select used by every /me/personal-deadlines response.
// customerId is intentionally excluded — it is the caller's own id and
// must not appear in the DTO (no third-party PII, and no self-leak either).
export const PERSONAL_DEADLINE_SELECT = {
  id: true,
  vehicleId: true,
  category: true,
  customLabel: true,
  dueDate: true,
  recurrenceMonths: true,
  reminderLeadDays: true,
  reminderDailyTailDays: true,
  notifyPush: true,
  notifyEmail: true,
  status: true,
  notes: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  vehicle: { select: { plate: true, make: true, model: true } },
} as const satisfies Prisma.PersonalDeadlineSelect;

type PersonalDeadlineRow = Prisma.PersonalDeadlineGetPayload<{
  select: typeof PERSONAL_DEADLINE_SELECT;
}>;

export interface PersonalDeadlineDto {
  id: string;
  vehicleId: string;
  vehicle: { plate: string; make: string; model: string };
  category: string;
  customLabel?: string;
  // @db.Date — serialized as bare YYYY-MM-DD, never as a full ISO timestamp
  dueDate: string;
  recurrenceMonths?: number;
  reminderLeadDays: number[];
  reminderDailyTailDays?: number;
  notifyPush: boolean;
  notifyEmail: boolean;
  status: string;
  notes?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export function serializePersonalDeadline(row: PersonalDeadlineRow): PersonalDeadlineDto {
  // dueDate is @db.Date — Prisma returns it as a Date at UTC midnight.
  // Slice the first 10 chars of the ISO string to get bare YYYY-MM-DD (see F-CLI-306).
  const dto: PersonalDeadlineDto = {
    id: row.id,
    vehicleId: row.vehicleId,
    vehicle: { plate: row.vehicle.plate, make: row.vehicle.make, model: row.vehicle.model },
    category: row.category,
    dueDate: row.dueDate.toISOString().slice(0, 10),
    reminderLeadDays: row.reminderLeadDays,
    notifyPush: row.notifyPush,
    notifyEmail: row.notifyEmail,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.customLabel != null) dto.customLabel = row.customLabel;
  if (row.recurrenceMonths != null) dto.recurrenceMonths = row.recurrenceMonths;
  if (row.reminderDailyTailDays != null) dto.reminderDailyTailDays = row.reminderDailyTailDays;
  if (row.notes != null) dto.notes = row.notes;
  if (row.completedAt != null) dto.completedAt = row.completedAt.toISOString();
  return dto;
}
