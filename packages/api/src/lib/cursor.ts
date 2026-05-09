// Cursor helpers for id-based pagination. Shared by /v1/vehicles/search
// and /v1/customers/search (this module landed when the customers
// endpoint became the second consumer). Base64url-encoded JSON `{ id }`
// is opaque enough to discourage clients from constructing cursors by
// hand while remaining easy to debug in logs.

export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      id?: string;
    };
    return typeof obj.id === 'string' ? obj.id : undefined;
  } catch {
    return undefined;
  }
}
