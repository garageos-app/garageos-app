import { describe, expect, it, beforeEach } from 'vitest';

import {
  clearOnboardingSkipped,
  isOnboardingSkipped,
  markOnboardingSkipped,
} from './onboardingSkip';

describe('onboardingSkip (session-scoped)', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('is not skipped by default', () => {
    expect(isOnboardingSkipped()).toBe(false);
  });

  it('mark → isSkipped true', () => {
    markOnboardingSkipped();
    expect(isOnboardingSkipped()).toBe(true);
  });

  it('clear → isSkipped false again', () => {
    markOnboardingSkipped();
    clearOnboardingSkipped();
    expect(isOnboardingSkipped()).toBe(false);
  });
});
