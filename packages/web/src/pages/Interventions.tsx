// IT-strings — hardcoded, no i18n in this app
import { Wrench, SearchX } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  InterventionsFilterBar,
  type InterventionFilterValues,
} from '@/components/interventions/InterventionsFilterBar';
import { InterventionsPagination } from '@/components/interventions/InterventionsPagination';
import { InterventionsTable } from '@/components/interventions/InterventionsTable';
import {
  parseInterventionsParams,
  serializeInterventionsParams,
  useInterventionsList,
  type InterventionsListParams,
} from '@/queries/interventionsList';

export function Interventions() {
  const [searchParams, setSearchParams] = useSearchParams();
  // URL is the source of truth for all filter/sort/page state.
  const params = parseInterventionsParams(searchParams);
  const query = useInterventionsList(params);

  // Any change other than an explicit page navigation resets to page 1.
  const update = (patch: Partial<InterventionsListParams>) => {
    const next: InterventionsListParams = { ...params, ...patch };
    if (!('page' in patch)) next.page = 1;
    setSearchParams(serializeInterventionsParams(next));
  };

  const filterValues: InterventionFilterValues = {
    q: params.q,
    status: params.status,
    typeId: params.typeId,
    checklistItemIds: params.checklistItemIds,
    operatorId: params.operatorId,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
  };

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div className="flex items-center gap-3">
        <Wrench size={24} className="text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Registro interventi</h1>
      </div>

      <InterventionsFilterBar values={filterValues} onChange={update} />

      {/* isError is exclusive: with keepPreviousData a failed refetch keeps
          stale data around, so gate the table/empty branches on !isError to
          avoid rendering the error alert and a stale table simultaneously. */}
      {query.isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{query.error instanceof Error ? query.error.message : 'Errore sconosciuto'}</span>
            <Button size="sm" variant="outline" onClick={() => query.refetch()}>
              Riprova
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!query.isError && query.isPending && (
        <div className="space-y-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      )}

      {!query.isError && query.data && query.data.items.length > 0 && (
        <div className="space-y-3">
          <InterventionsTable
            items={query.data.items}
            sort={params.sort}
            order={params.order}
            onSortChange={(sort) =>
              update({
                sort,
                order: sort === params.sort && params.order === 'desc' ? 'asc' : 'desc',
              })
            }
          />
          <InterventionsPagination
            page={params.page}
            total={query.data.total}
            onPageChange={(page) => update({ page })}
          />
        </div>
      )}

      {!query.isError && query.data && query.data.items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <SearchX size={48} className="mb-3" />
          <div className="font-medium text-foreground">Nessun intervento trovato.</div>
          {/* A page beyond the last (bookmarked ?page=N or a shrunk result set)
              yields zero items with no pagination controls — offer a way back. */}
          {params.page > 1 && (
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => update({ page: 1 })}
            >
              Torna alla prima pagina
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
