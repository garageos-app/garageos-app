import { useEffect, useState } from 'react';

// Returns a value that lags behind the input by `ms` milliseconds.
// Used by CustomerAutocomplete to coalesce keystrokes before firing
// the /v1/customers/search query.
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(handle);
  }, [value, ms]);

  return debounced;
}
