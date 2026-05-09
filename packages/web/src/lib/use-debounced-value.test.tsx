import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useDebouncedValue } from './use-debounced-value';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('hello', 250));
    expect(result.current).toBe('hello');
  });

  it('does not update before the delay has elapsed', () => {
    const { result, rerender } = renderHook(({ v }: { v: string }) => useDebouncedValue(v, 250), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'ab' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe('a');
  });

  it('updates after the delay has elapsed', () => {
    const { result, rerender } = renderHook(({ v }: { v: string }) => useDebouncedValue(v, 250), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'ab' });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current).toBe('ab');
  });

  it('resets the timer on each new value', () => {
    const { result, rerender } = renderHook(({ v }: { v: string }) => useDebouncedValue(v, 250), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'ab' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ v: 'abc' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe('a');
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toBe('abc');
  });
});
