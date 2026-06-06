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
      // The API serialises every error as RFC 7807 Problem Details
      // (application/problem+json): the machine code lives in `code` and
      // the human message in `detail` (see api/src/plugins/error-handler.ts).
      // Fall back to legacy error_code/error_message for any non-conforming
      // response so older or third-party shapes still map to a code.
      if (typeof obj.code === 'string') code = obj.code;
      else if (typeof obj.error_code === 'string') code = obj.error_code;
      if (typeof obj.detail === 'string') message = obj.detail;
      else if (typeof obj.error_message === 'string') message = obj.error_message;
    }
    return new ApiError(code, status, message, body);
  }
}
