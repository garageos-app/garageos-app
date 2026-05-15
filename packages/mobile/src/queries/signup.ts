// Pure fetch wrappers for the public auth endpoints.
// These DO NOT use apiClient because:
//  - signup / resend-verification are public (no Bearer token).
//  - apiClient injects Authorization unconditionally and triggers
//    onAuthLost on 401 — wrong semantics for an unauthenticated caller.
//
// Discriminated return shape — callers branch on `result.ok`, exactly
// the pattern used by queries/changePassword.ts (PR #105).
//
// API returns RFC 7807 problem+json with { code, detail, ... }.
// Note: existing api-error.ts reads error_code/error_message — that's a
// latent bug in the existing api-client path; do NOT fix it here.

const FALLBACK_MESSAGE = 'Si è verificato un errore. Riprova più tardi.';
const NETWORK_MESSAGE = 'Connessione assente. Controlla la rete.';

export type SignupInput = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
};

export type SignupCustomer = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: string;
  createdAt: string;
};

export type SignupResult =
  | { ok: true; customer: SignupCustomer }
  | { ok: false; code: string; message: string };

export type ResendResult = { ok: true } | { ok: false; code: string; message: string };

function getBaseUrl(): string {
  const url = process.env.EXPO_PUBLIC_API_URL;
  if (!url) throw new Error('EXPO_PUBLIC_API_URL is not set');
  return url;
}

function parseProblem(status: number, body: unknown): { code: string; message: string } {
  let code = `http.${status}`;
  let message = FALLBACK_MESSAGE;
  if (typeof body === 'object' && body !== null) {
    const obj = body as Record<string, unknown>;
    if (typeof obj.code === 'string') code = obj.code;
    if (typeof obj.detail === 'string') message = obj.detail;
  }
  return { code, message };
}

export async function signupCustomer(input: SignupInput): Promise<SignupResult> {
  const url = `${getBaseUrl()}/v1/auth/signup`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ type: 'customer', ...input }),
    });
  } catch {
    return { ok: false, code: 'network.unreachable', message: NETWORK_MESSAGE };
  }

  const body = await res.json().catch(() => ({}));

  if (res.ok) {
    const customer = (body as { customer?: SignupCustomer }).customer;
    if (!customer) {
      return { ok: false, code: 'http.unexpected_body', message: FALLBACK_MESSAGE };
    }
    return { ok: true, customer };
  }

  const { code, message } = parseProblem(res.status, body);
  return { ok: false, code, message };
}

export async function resendVerification(email: string): Promise<ResendResult> {
  const url = `${getBaseUrl()}/v1/auth/resend-verification`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email }),
    });
  } catch {
    return { ok: false, code: 'network.unreachable', message: NETWORK_MESSAGE };
  }

  if (res.ok) return { ok: true };

  const body = await res.json().catch(() => ({}));
  const { code, message } = parseProblem(res.status, body);
  return { ok: false, code, message };
}
