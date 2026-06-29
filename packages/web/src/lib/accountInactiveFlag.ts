// Session-scoped "account inactive" terminal signal.
//
// When the API rejects an otherwise-valid session with `auth.session.inactive`
// (officine user disabled or tenant suspended), AuthContext enters the terminal
// `account_inactive` state. That state lives only in the in-memory reducer, so
// without a persisted flag a reload would rehydrate the still-valid Cognito
// session straight back to `authenticated`, flash the app shell, and re-issue
// authenticated requests from a principal the backend has already disabled —
// only to bounce back to the terminal screen on the next 401.
//
// sessionStorage gives the right semantics: survives reload / silent re-auth (a
// reload is not a login), cleared when the tab closes, and cleared explicitly on
// signOut (the "Torna al login" exit) so a same-tab logout re-enables a fresh
// login. This mirrors lib/onboardingSkip.ts.

export const ACCOUNT_INACTIVE_KEY = 'garageos.accountInactive';

export function markAccountInactiveFlag(): void {
  try {
    sessionStorage.setItem(ACCOUNT_INACTIVE_KEY, '1');
  } catch {
    // sessionStorage unavailable (private mode / SSR) — degrade to no-op.
  }
}

export function isAccountInactiveFlag(): boolean {
  try {
    return sessionStorage.getItem(ACCOUNT_INACTIVE_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearAccountInactiveFlag(): void {
  try {
    sessionStorage.removeItem(ACCOUNT_INACTIVE_KEY);
  } catch {
    // no-op
  }
}
