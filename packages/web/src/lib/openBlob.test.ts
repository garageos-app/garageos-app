import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api-client';
import { openBlobInNewTab } from './openBlob';

function pdfBlob(): Blob {
  return new Blob(['%PDF-1.4'], { type: 'application/pdf' });
}

describe('openBlobInNewTab', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the blob in a new tab via an object URL', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    openBlobInNewTab(pdfBlob());
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(openSpy).toHaveBeenCalledWith('blob:mock', '_blank');
  });

  it('throws ApiError(client.popup_blocked) when the browser blocks the popup', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    let caught: unknown;
    try {
      openBlobInNewTab(pdfBlob());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('client.popup_blocked');
  });
});
