// ApiError — uniform error type thrown by the api-client.
// See plan 2026-05-14-mobile-b2c-scaffold §Task 5.1 and spec §6.1.

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static network(): ApiError {
    return new ApiError('network.unreachable', 0, 'Connessione assente. Controlla la rete.');
  }

  static fromResponse(status: number, body: unknown): ApiError {
    let code = `http.${status}`;
    let message = 'Si è verificato un errore. Riprova più tardi.';
    if (typeof body === 'object' && body !== null) {
      const obj = body as Record<string, unknown>;
      if (typeof obj.error_code === 'string') code = obj.error_code;
      if (typeof obj.error_message === 'string') message = obj.error_message;
    }
    return new ApiError(code, status, message, body);
  }
}
