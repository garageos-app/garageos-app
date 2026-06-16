import { addDays, format, startOfToday } from 'date-fns';

import { validatePersonalDeadlineForm } from '@/lib/validators/personalDeadline';
import type { PersonalDeadlineFormInput } from '@/lib/validators/personalDeadline';

const VALID: PersonalDeadlineFormInput = {
  vehicleId: '550e8400-e29b-41d4-a716-446655440000',
  category: 'insurance',
  customLabel: '',
  dueDate: format(startOfToday(), 'yyyy-MM-dd'),
  reminderLeadDays: [30, 7, 0],
  reminderDailyTailDays: 0,
  notifyPush: true,
  notifyEmail: true,
  recurrenceMonths: 0,
  notes: '',
};

describe('validatePersonalDeadlineForm', () => {
  it('returns no errors for a fully valid input', () => {
    expect(validatePersonalDeadlineForm(VALID)).toEqual({});
  });

  it('requires vehicleId', () => {
    expect(validatePersonalDeadlineForm({ ...VALID, vehicleId: '  ' }).vehicleId).toBeDefined();
  });

  it('requires customLabel when category is other (BR-294)', () => {
    expect(
      validatePersonalDeadlineForm({ ...VALID, category: 'other', customLabel: '' }).customLabel,
    ).toBeDefined();
  });

  it('rejects customLabel longer than 80 chars', () => {
    expect(
      validatePersonalDeadlineForm({ ...VALID, customLabel: 'x'.repeat(81) }).customLabel,
    ).toBe('Massimo 80 caratteri');
  });

  it('requires dueDate', () => {
    expect(validatePersonalDeadlineForm({ ...VALID, dueDate: '' }).dueDate).toBeDefined();
  });

  it('rejects a past dueDate by default (create mode)', () => {
    const past = format(addDays(startOfToday(), -3), 'yyyy-MM-dd');
    expect(validatePersonalDeadlineForm({ ...VALID, dueDate: past }).dueDate).toBe(
      'La data non può essere nel passato',
    );
  });

  it('allows a past dueDate when allowPastDate is set (edit mode)', () => {
    const past = format(addDays(startOfToday(), -3), 'yyyy-MM-dd');
    expect(
      validatePersonalDeadlineForm({ ...VALID, dueDate: past }, { allowPastDate: true }).dueDate,
    ).toBeUndefined();
  });

  it('rejects a malformed dueDate', () => {
    expect(validatePersonalDeadlineForm({ ...VALID, dueDate: '2026-13-40' }).dueDate).toBe(
      'Data non valida (AAAA-MM-GG)',
    );
  });

  it('requires at least one reminder when tail is 0 (BR-293)', () => {
    expect(
      validatePersonalDeadlineForm({ ...VALID, reminderLeadDays: [], reminderDailyTailDays: 0 })
        .form,
    ).toBe('Scegli almeno un promemoria');
  });

  it('requires at least one notification channel (BR-292)', () => {
    expect(
      validatePersonalDeadlineForm({ ...VALID, notifyPush: false, notifyEmail: false }).form,
    ).toBe('Attiva almeno un canale di notifica (push o email)');
  });

  it('lets the reminder error win when both reminder and channel are violated', () => {
    expect(
      validatePersonalDeadlineForm({
        ...VALID,
        reminderLeadDays: [],
        reminderDailyTailDays: 0,
        notifyPush: false,
        notifyEmail: false,
      }).form,
    ).toBe('Scegli almeno un promemoria');
  });

  it('rejects reminderDailyTailDays greater than 30', () => {
    expect(
      validatePersonalDeadlineForm({ ...VALID, reminderDailyTailDays: 31 }).reminderDailyTailDays,
    ).toBeDefined();
  });

  it('rejects recurrenceMonths outside 1–120 range when non-zero', () => {
    expect(
      validatePersonalDeadlineForm({ ...VALID, recurrenceMonths: 130 }).recurrenceMonths,
    ).toBeDefined();
  });

  it('rejects notes longer than 500 chars', () => {
    expect(validatePersonalDeadlineForm({ ...VALID, notes: 'x'.repeat(501) }).notes).toBeDefined();
  });
});
