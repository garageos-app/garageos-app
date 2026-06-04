import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { personaEmail } from '../../../prisma/seeds/pilot-demo-data.js';

// personaEmail keeps the PUBLIC repo free of real PII: the committed default
// resolves to the non-deliverable `demo-giuseppe.test` domain, and only an
// operator-supplied PILOT_DEMO_EMAIL_BASE turns personas into deliverable
// Gmail plus-aliases for the real pilot demo.

describe('personaEmail', () => {
  let savedBase: string | undefined;

  beforeEach(() => {
    savedBase = process.env.PILOT_DEMO_EMAIL_BASE;
  });

  afterEach(() => {
    if (savedBase === undefined) {
      delete process.env.PILOT_DEMO_EMAIL_BASE;
    } else {
      process.env.PILOT_DEMO_EMAIL_BASE = savedBase;
    }
  });

  it('falls back to the non-deliverable .test domain when no base is set', () => {
    delete process.env.PILOT_DEMO_EMAIL_BASE;
    expect(personaEmail('mario')).toBe('mario@demo-giuseppe.test');
    expect(personaEmail('giuseppe')).toBe('giuseppe@demo-giuseppe.test');
  });

  it('derives a Gmail plus-alias from a deliverable base address', () => {
    process.env.PILOT_DEMO_EMAIL_BASE = 'someone@gmail.com';
    expect(personaEmail('mario')).toBe('someone+mario@gmail.com');
    expect(personaEmail('giuseppe')).toBe('someone+giuseppe@gmail.com');
    expect(personaEmail('officina')).toBe('someone+officina@gmail.com');
  });

  it('preserves an arbitrary base domain (not only gmail.com)', () => {
    process.env.PILOT_DEMO_EMAIL_BASE = 'pilot@example.org';
    expect(personaEmail('luigi')).toBe('pilot+luigi@example.org');
  });

  it('falls back to the default domain when the base lacks an @', () => {
    process.env.PILOT_DEMO_EMAIL_BASE = 'not-an-email';
    expect(personaEmail('anna')).toBe('anna@demo-giuseppe.test');
  });
});
