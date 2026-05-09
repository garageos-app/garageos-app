// IT-strings — hardcoded
import { Link, useSearchParams } from 'react-router-dom';
import { SearchX } from 'lucide-react';

import { useVehicleSearch } from '@/queries/vehicleSearch';
import { useCustomerDetail } from '@/queries/customerDetail';
import type { SearchType } from '@/lib/search-input';
import { VehicleResultCard } from '@/components/VehicleResultCard';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const typeLabel: Record<SearchType, string> = {
  vin: 'VIN',
  plate: 'targa',
  garage_code: 'codice GarageOS',
  customer: 'cliente',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidType(t: string | null): t is SearchType {
  return t === 'vin' || t === 'plate' || t === 'garage_code' || t === 'customer';
}

function paramsForCustomer(
  customerId: string | null,
): { kind: 'customer'; customerId: string } | null {
  if (!customerId || !UUID_RE.test(customerId)) return null;
  return { kind: 'customer', customerId };
}

export function SearchResults() {
  const [params] = useSearchParams();
  const tRaw = params.get('t');
  const t = isValidType(tRaw) ? tRaw : null;

  if (t === 'customer') {
    return <SearchResultsByCustomer customerId={params.get('customer')} />;
  }

  const q = params.get('q')?.trim() ?? '';
  return <SearchResultsByQuery q={q} t={t} />;
}

function SearchResultsByCustomer({ customerId }: { customerId: string | null }) {
  const queryParams = paramsForCustomer(customerId);
  const query = useVehicleSearch(queryParams ?? { kind: 'customer', customerId: '' });
  const items = query.data?.pages.flatMap((p) => p.data) ?? [];
  // Fetch customer detail to display the name in the header. The detail
  // endpoint enforces BR-151 — if the caller has no CTR, the hook errors
  // and we fall back to the UUID display.
  const customer = useCustomerDetail(queryParams?.customerId ?? '');

  if (!queryParams) {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertDescription>Parametri di ricerca mancanti o invalidi.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const customerLabel =
    customer.data &&
    (customer.data.isBusiness && customer.data.businessName
      ? customer.data.businessName
      : `${customer.data.firstName} ${customer.data.lastName}`);

  return (
    <ResultsLayout
      header={
        <div>
          <div className="text-sm text-muted-foreground mb-2">
            Veicoli del <Badge variant="outline">cliente</Badge>
          </div>
          <Link
            to={`/customers/${queryParams.customerId}`}
            className="text-lg font-semibold text-foreground hover:underline"
          >
            {customerLabel ?? <span className="font-mono">{queryParams.customerId}</span>}
          </Link>
        </div>
      }
      query={query}
      items={items}
    />
  );
}

function SearchResultsByQuery({ q, t }: { q: string; t: SearchType | null }) {
  const query = useVehicleSearch({ kind: 'query', q, t });
  const items = query.data?.pages.flatMap((p) => p.data) ?? [];

  if (!q || !t || t === 'customer') {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertDescription>Parametri di ricerca mancanti o invalidi.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <ResultsLayout
      header={
        <div>
          <div className="text-sm text-muted-foreground mb-2">
            Ricerca per <Badge variant="outline">{typeLabel[t]}</Badge>
          </div>
          <div className="font-mono text-lg font-semibold text-foreground">{q}</div>
        </div>
      }
      query={query}
      items={items}
    />
  );
}

interface ResultsLayoutProps {
  header: React.ReactNode;
  query: ReturnType<typeof useVehicleSearch>;
  items: Array<{ id: string }>;
}

function ResultsLayout({ header, query, items }: ResultsLayoutProps) {
  return (
    <div className="p-8 space-y-6">
      {header}

      {query.isPending && (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}

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

      {query.isSuccess && items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <SearchX size={48} className="mb-3" />
          <div className="font-medium text-foreground">Nessun veicolo trovato.</div>
          <div className="text-sm">Verifica il dato inserito.</div>
        </div>
      )}

      {query.isSuccess && items.length > 0 && (
        <>
          <div className="text-sm text-muted-foreground">
            {items.length} risultat{items.length === 1 ? 'o' : 'i'}
          </div>
          <div className="space-y-3">
            {items.map((v) => (
              <VehicleResultCard key={v.id} vehicle={v as never} />
            ))}
          </div>
          {query.hasNextPage && (
            <div className="pt-4">
              <Button
                variant="outline"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? 'Caricamento…' : 'Carica altri'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
