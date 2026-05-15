import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cropAndResize } from './avatarCanvas';

describe('cropAndResize', () => {
  const drawImageSpy = vi.fn();
  const toBlobSpy = vi.fn();

  beforeEach(() => {
    drawImageSpy.mockReset();
    toBlobSpy.mockReset();

    // Stub canvas.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      drawImage: drawImageSpy,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    // Stub canvas.toBlob to invoke the callback with a fake Blob
    HTMLCanvasElement.prototype.toBlob = vi.fn(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
      type?: string,
      quality?: unknown,
    ) {
      toBlobSpy(type, quality);
      callback(new Blob(['fake'], { type: type ?? 'image/jpeg' }));
    }) as typeof HTMLCanvasElement.prototype.toBlob;

    // Stub Image load — fire onload synchronously next tick
    Object.defineProperty(global, 'Image', {
      writable: true,
      configurable: true,
      value: class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = '';
        constructor() {
          queueMicrotask(() => this.onload?.());
        }
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('outputs JPEG blob at 512x512 with quality 0.85', async () => {
    const blob = await cropAndResize('blob:fake', { x: 0, y: 0, width: 100, height: 100 });
    expect(blob.type).toBe('image/jpeg');
    expect(toBlobSpy).toHaveBeenCalledWith('image/jpeg', 0.85);
  });

  it('calls drawImage with crop coords + 512px output size', async () => {
    await cropAndResize('blob:fake', { x: 10, y: 20, width: 100, height: 100 });
    expect(drawImageSpy).toHaveBeenCalledTimes(1);
    const call = drawImageSpy.mock.calls[0]!;
    // signature: (image, sx, sy, sw, sh, dx, dy, dw, dh)
    expect(call[1]).toBe(10);
    expect(call[2]).toBe(20);
    expect(call[3]).toBe(100);
    expect(call[4]).toBe(100);
    expect(call[5]).toBe(0);
    expect(call[6]).toBe(0);
    expect(call[7]).toBe(512);
    expect(call[8]).toBe(512);
  });

  it('accepts custom output size + quality', async () => {
    await cropAndResize('blob:fake', { x: 0, y: 0, width: 100, height: 100 }, 256, 0.7);
    expect(drawImageSpy.mock.calls[0]![7]).toBe(256);
    expect(toBlobSpy).toHaveBeenCalledWith('image/jpeg', 0.7);
  });
});
