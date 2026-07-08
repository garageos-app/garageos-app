import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';

// GET /v1/interventions — "Registro Interventi" web hook + URL codec (PR-2).
// Mirrors the wire contract of packages/api/src/routes/v1/interventions-list.ts.
// The URL query string is the source of truth for the page's filter/sort/page
// state; parse/serialize convert between URLSearchParams and the typed shape.

export type InterventionStatus = 'active' | 'disputed' | 'cancelled';
export type InterventionSort = 'date' | 'status' | 'type' | 'operator' | 'km';
export type SortOrder = 'asc' | 'desc';

export interface InterventionListItem {
  id: string;
  interventionDate: string; // 'YYYY-MM-DD'
  odometerKm: number;
  status: InterventionStatus;
  type: { id: string; nameIt: string };
  vehicle: { id: string; plate: string; make: string; model: string };
  operator: { id: string; name: string };
}

export interface InterventionsListResponse {
  items: InterventionListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface InterventionsListParams {
  page: number;
  q: string; // '' when unset
  status: InterventionStatus[]; // [] = "default" (active,disputed); handled server-side
  typeId: string[];
  checklistItemIds: string[];
  operatorId: string[];
  dateFrom: string; // '' or 'YYYY-MM-DD'
  dateTo: string;
  sort: InterventionSort;
  order: SortOrder;
}

export const PAGE_SIZE = 25;
export const DEFAULT_STATUS: InterventionStatus[] = ['active', 'disputed'];

const SORT_VALUES: readonly InterventionSort[] = ['date', 'status', 'type', 'operator', 'km'];
const ORDER_VALUES: readonly SortOrder[] = ['asc', 'desc'];

// CSV param -> trimmed, non-empty tokens (mirrors the backend csvArray split).
function csv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function parseInterventionsParams(sp: URLSearchParams): InterventionsListParams {
  const rawPage = Number.parseInt(sp.get('page') ?? '', 10);
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;

  const rawSort = sp.get('sort');
  const sort = SORT_VALUES.includes(rawSort as InterventionSort)
    ? (rawSort as InterventionSort)
    : 'date';

  const rawOrder = sp.get('order');
  const order = ORDER_VALUES.includes(rawOrder as SortOrder) ? (rawOrder as SortOrder) : 'desc';

  return {
    page,
    q: sp.get('q') ?? '',
    status: csv(sp.get('status')) as InterventionStatus[],
    typeId: csv(sp.get('typeId')),
    checklistItemIds: csv(sp.get('checklistItemIds')),
    operatorId: csv(sp.get('operatorId')),
    dateFrom: sp.get('dateFrom') ?? '',
    dateTo: sp.get('dateTo') ?? '',
    sort,
    order,
  };
}

export function serializeInterventionsParams(p: InterventionsListParams): URLSearchParams {
  const sp = new URLSearchParams();
  if (p.page > 1) sp.set('page', String(p.page));
  if (p.q) sp.set('q', p.q);
  if (p.status.length) sp.set('status', p.status.join(','));
  if (p.typeId.length) sp.set('typeId', p.typeId.join(','));
  // checklistItemIds only meaningful with exactly one type selected.
  if (p.checklistItemIds.length && p.typeId.length === 1) {
    sp.set('checklistItemIds', p.checklistItemIds.join(','));
  }
  if (p.operatorId.length) sp.set('operatorId', p.operatorId.join(','));
  if (p.dateFrom) sp.set('dateFrom', p.dateFrom);
  if (p.dateTo) sp.set('dateTo', p.dateTo);
  if (p.sort !== 'date') sp.set('sort', p.sort);
  if (p.order !== 'desc') sp.set('order', p.order);
  return sp;
}

// Build the API query string. Always sends pageSize; omits empty filters.
// Defensively drops checklistItemIds unless exactly one typeId is selected,
// mirroring the backend Zod refine (interventions-list.schema.ts).
function buildApiQuery(p: InterventionsListParams): string {
  const sp = new URLSearchParams();
  sp.set('page', String(p.page));
  sp.set('pageSize', String(PAGE_SIZE));
  if (p.q) sp.set('q', p.q);
  if (p.status.length) sp.set('status', p.status.join(','));
  if (p.typeId.length) sp.set('typeId', p.typeId.join(','));
  if (p.checklistItemIds.length && p.typeId.length === 1) {
    sp.set('checklistItemIds', p.checklistItemIds.join(','));
  }
  if (p.operatorId.length) sp.set('operatorId', p.operatorId.join(','));
  if (p.dateFrom) sp.set('dateFrom', p.dateFrom);
  if (p.dateTo) sp.set('dateTo', p.dateTo);
  sp.set('sort', p.sort);
  sp.set('order', p.order);
  return sp.toString();
}

export function useInterventionsList(p: InterventionsListParams) {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['interventions', 'list', p] as const,
    queryFn: () => apiFetch<InterventionsListResponse>(`/v1/interventions?${buildApiQuery(p)}`),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
