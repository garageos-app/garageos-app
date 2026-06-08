// F-OFF-002 — session-scoped "onboarding skipped" signal.
//
// «Salta configurazione» must let the super_admin into the app for the
// CURRENT browsing session without persisting completion to the backend
// (the wizard should reappear at the next login). The OnboardingGate
// redirects whenever onboardingCompletedAt is null, so without a
// session-scoped suppressor the user bounces straight back to /onboarding.
//
// sessionStorage matches the desired semantics: survives reload / silent
// re-auth (a reload is not a login), cleared when the tab closes, and
// cleared explicitly on signOut (AuthContext) so a same-tab logout→login
// re-prompts. localStorage would suppress forever; in-memory would
// re-prompt on every reload.

export const ONBOARDING_SKIP_KEY = 'garageos.onboardingSkipped';

export function markOnboardingSkipped(): void {
  try {
    sessionStorage.setItem(ONBOARDING_SKIP_KEY, '1');
  } catch {
    // sessionStorage unavailable (private mode / SSR) — degrade to no-op.
  }
}

export function isOnboardingSkipped(): boolean {
  try {
    return sessionStorage.getItem(ONBOARDING_SKIP_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearOnboardingSkipped(): void {
  try {
    sessionStorage.removeItem(ONBOARDING_SKIP_KEY);
  } catch {
    // no-op
  }
}
