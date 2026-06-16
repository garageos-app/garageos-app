// Personal deadline types — mirrors GET /v1/me/personal-deadlines response
// shape (F-CLI-306). dueDate is a bare YYYY-MM-DD string (@db.Date field).

export type PersonalDeadlineCategory =
  | 'insurance'
  | 'road_tax'
  | 'inspection'
  | 'service'
  | 'tires'
  | 'timing_belt'
  | 'other';

export type PersonalDeadlineStatus = 'open' | 'completed' | 'overdue' | 'cancelled';

export type PersonalDeadlineDto = {
  id: string;
  vehicleId: string;
  vehicle: { plate: string; make: string; model: string };
  category: PersonalDeadlineCategory;
  customLabel?: string;
  /** Bare YYYY-MM-DD — never pass directly to `new Date()`; use date-fns parse. */
  dueDate: string;
  recurrenceMonths?: number;
  reminderLeadDays: number[];
  reminderDailyTailDays?: number;
  notifyPush: boolean;
  notifyEmail: boolean;
  status: PersonalDeadlineStatus;
  notes?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type PersonalDeadlineDetailResponse = {
  personalDeadline: PersonalDeadlineDto;
};

export type PersonalDeadlinesListResponse = {
  data: PersonalDeadlineDto[];
};

// Returned alongside a completion response (BR-296 renewal suggestion).
export type RenewalSuggestion = {
  /** Bare YYYY-MM-DD */
  suggestedDueDate: string;
  category: PersonalDeadlineCategory;
  customLabel?: string;
  recurrenceMonths: number;
  reminderLeadDays: number[];
  reminderDailyTailDays?: number;
  notifyPush: boolean;
  notifyEmail: boolean;
};

export type CompletePersonalDeadlineResponse = {
  personalDeadline: PersonalDeadlineDto;
  renewalSuggestion?: RenewalSuggestion;
};

// POST /v1/me/personal-deadlines request body.
export type CreatePersonalDeadlineBody = {
  vehicleId: string;
  category: PersonalDeadlineCategory;
  customLabel?: string;
  /** Bare YYYY-MM-DD */
  dueDate: string;
  recurrenceMonths?: number;
  reminderLeadDays: number[];
  reminderDailyTailDays?: number;
  notifyPush: boolean;
  notifyEmail: boolean;
  notes?: string;
};

// PATCH /v1/me/personal-deadlines/:id request body.
// All fields optional; nullable-clearable fields also accept null.
export type UpdatePersonalDeadlineBody = {
  category?: PersonalDeadlineCategory;
  customLabel?: string | null;
  /** Bare YYYY-MM-DD */
  dueDate?: string;
  recurrenceMonths?: number | null;
  reminderLeadDays?: number[];
  reminderDailyTailDays?: number | null;
  notifyPush?: boolean;
  notifyEmail?: boolean;
  notes?: string | null;
};
