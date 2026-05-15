import { describe, it, expect } from 'vitest';
import { passwordPolicySchema, changePasswordFormSchema } from './password';

describe('passwordPolicySchema', () => {
  it('rejects strings shorter than 10 chars', () => {
    const r = passwordPolicySchema.safeParse('Abc123de');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Almeno 10 caratteri');
    }
  });

  it('rejects strings missing a lowercase letter', () => {
    const r = passwordPolicySchema.safeParse('ABCDEFG123');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Almeno una lettera minuscola');
    }
  });

  it('rejects strings missing an uppercase letter', () => {
    const r = passwordPolicySchema.safeParse('abcdefg123');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Almeno una lettera maiuscola');
    }
  });

  it('rejects strings missing a digit', () => {
    const r = passwordPolicySchema.safeParse('Abcdefghij');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Almeno un numero');
    }
  });

  it('accepts a policy-compliant password', () => {
    const r = passwordPolicySchema.safeParse('Abcdefg123');
    expect(r.success).toBe(true);
  });
});

describe('changePasswordFormSchema', () => {
  it('rejects mismatched newPassword and confirmPassword', () => {
    const r = changePasswordFormSchema.safeParse({
      oldPassword: 'OldPass123',
      newPassword: 'NewPass456',
      confirmPassword: 'Different789',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.find((i) => i.path.includes('confirmPassword'))?.message;
      expect(msg).toBe('Le password non coincidono');
    }
  });

  it('rejects newPassword equal to oldPassword', () => {
    const r = changePasswordFormSchema.safeParse({
      oldPassword: 'SamePass123',
      newPassword: 'SamePass123',
      confirmPassword: 'SamePass123',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.find((i) => i.path.includes('newPassword'))?.message;
      expect(msg).toBe('La nuova password deve essere diversa dalla precedente');
    }
  });

  it('accepts a valid payload', () => {
    const r = changePasswordFormSchema.safeParse({
      oldPassword: 'OldPass123',
      newPassword: 'NewPass456',
      confirmPassword: 'NewPass456',
    });
    expect(r.success).toBe(true);
  });
});
