// useMeVehicleAccessLog — infinite query for GET /v1/me/vehicles/:id/access-log
// (F-CLI-304 / BR-155). Cursor pagination consumed via a "Carica altri" button
// (not onEndReached: the tab renders inside a parent ScrollView). select()
// flattens the pages to a flat CustomerAccessEntry[]. Lazy: enabled is driven by
// the active tab so the call only fires when the customer opens the Accessi tab.
import { useInfiniteQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type { AccessLogPage, CustomerAccessEntry } from '@/lib/types/accessLog';

export function useMeVehicleAccessLog(vehicleId: string, opts: { enabled: boolean }) {
  const api = useApiClient();
  return useInfiniteQuery<
    AccessLogPage,
    Error,
    CustomerAccessEntry[],
    readonly unknown[],
    string | undefined
  >({
    queryKey: ['me', 'vehicle', vehicleId, 'access-log'],
    queryFn: ({ pageParam }) =>
      api.fetch<AccessLogPage>(
        `/v1/me/vehicles/${vehicleId}/access-log${
          pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''
        }`,
      ),
    initialPageParam: undefined,
    getNextPageParam: (last) => (last.meta.has_more ? last.meta.cursor : undefined),
    select: (data) => data.pages.flatMap((p) => p.data),
    enabled: opts.enabled && vehicleId.length > 0,
  });
}
