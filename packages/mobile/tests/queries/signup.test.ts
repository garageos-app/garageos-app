import { signupCustomer, resendVerification } from '@/queries/signup';

describe('signupCustomer', () => {
  const apiUrl = 'https://api.test.example.com';
  const input = {
    email: 'mario.rossi@example.com',
    password: 'miapassword1',
    firstName: 'Mario',
    lastName: 'Rossi',
  };

  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_URL = apiUrl;
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn();
  });

  it('POSTs to /v1/auth/signup with type=customer and returns customer on 201', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        customer: {
          id: 'cust-1',
          email: 'mario.rossi@example.com',
          firstName: 'Mario',
          lastName: 'Rossi',
          status: 'active',
          createdAt: '2026-05-15T12:00:00Z',
        },
      }),
    });

    const result = await signupCustomer(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.customer.email).toBe('mario.rossi@example.com');
    }
    expect(fetch).toHaveBeenCalledWith(
      `${apiUrl}/v1/auth/signup`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ type: 'customer', ...input }),
      }),
    );
    // Public endpoint — must NOT send Authorization header
    const headers = (fetch as unknown as jest.Mock).mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBeUndefined();
  });

  it('parses RFC 7807 problem+json code on 409', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        type: 'https://garageos/errors/auth.signup.email_already_active',
        title: 'Conflict',
        status: 409,
        code: 'auth.signup.email_already_active',
        detail: 'Un account con questa email è già registrato.',
      }),
    });

    const result = await signupCustomer(input);

    expect(result).toEqual({
      ok: false,
      code: 'auth.signup.email_already_active',
      message: 'Un account con questa email è già registrato.',
    });
  });

  it('parses 422 password_policy_violation', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({
        code: 'auth.signup.password_policy_violation',
        detail: 'La password non rispetta i requisiti.',
      }),
    });

    const result = await signupCustomer(input);
    expect(result).toMatchObject({
      ok: false,
      code: 'auth.signup.password_policy_violation',
    });
  });

  it('parses 429 rate_limited', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        code: 'auth.signup.rate_limited',
        detail: 'Troppi tentativi.',
      }),
    });

    const result = await signupCustomer(input);
    expect(result).toMatchObject({ ok: false, code: 'auth.signup.rate_limited' });
  });

  it('parses 502 cognito_unavailable', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({
        code: 'auth.signup.cognito_unavailable',
        detail: 'Servizio non disponibile.',
      }),
    });

    const result = await signupCustomer(input);
    expect(result).toMatchObject({ ok: false, code: 'auth.signup.cognito_unavailable' });
  });

  it('returns network.unreachable on fetch throw', async () => {
    (fetch as unknown as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));

    const result = await signupCustomer(input);
    expect(result).toEqual({
      ok: false,
      code: 'network.unreachable',
      message: 'Connessione assente. Controlla la rete.',
    });
  });

  it('falls back to generic code when problem+json body missing', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const result = await signupCustomer(input);
    expect(result).toMatchObject({ ok: false, code: 'http.500' });
  });
});

describe('resendVerification', () => {
  const apiUrl = 'https://api.test.example.com';

  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_URL = apiUrl;
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn();
  });

  it('POSTs email and returns ok on 200', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sent: true }),
    });

    const result = await resendVerification('mario.rossi@example.com');

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(
      `${apiUrl}/v1/auth/resend-verification`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'mario.rossi@example.com' }),
      }),
    );
  });

  it('returns rate_limited on 429', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        code: 'auth.resend_verification.rate_limited',
        detail: 'Troppi tentativi.',
      }),
    });

    const result = await resendVerification('mario.rossi@example.com');
    expect(result).toMatchObject({
      ok: false,
      code: 'auth.resend_verification.rate_limited',
    });
  });

  it('returns network.unreachable on fetch throw', async () => {
    (fetch as unknown as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));
    const result = await resendVerification('mario.rossi@example.com');
    expect(result).toMatchObject({ ok: false, code: 'network.unreachable' });
  });
});
