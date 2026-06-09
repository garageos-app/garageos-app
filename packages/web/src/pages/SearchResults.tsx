// IT-strings — hardcoded
import { Link, useSearchParams } from 'react-router-dom';
import { SearchX } from 'lucide-react';

import { useVehicleSearch } from '@/queries/vehicleSearch';
import { useCustomerSearch } from '@/queries/customerSearch';
import { useCustomerDetail } from '@/queries/customerDetail';
import { parseSearchInput } from '@/lib/search-input';
import { VehicleResultCard } from '@/components/VehicleResultCard';
import { CustomerResultCard } from '@/components/CustomerResultCard';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { Customer, VehicleSearchItem } from '@/queries/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function paramsForCustomer(
  customerId: string | null,
): { kind: 'customer'; customerId: string } | null {
  if (!customerId || !UUID_RE.test(customerId)) return null;
  return { kind: 'customer', customerId };
}

export function SearchResults() {
  const [params] = useSearchParams();
  // Legacy path from CustomerAutocomplete: /search?customer=<id>&t=customer
  // → the vehicles owned by a single customer. Unchanged.
  if (params.get('t') === 'customer') {
    return <SearchResultsByCustomer customerId={params.get('customer')} />;
  }
  const q = params.get('q')?.trim() ?? '';
  return <GlobalSearchResults q={q} />;
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
    <div className="p-8 space-y-6">
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
      <VehiclesList query={query} items={items} />
    </div>
  );
}

function GlobalSearchResults({ q }: { q: string }) {
  const parsed = parseSearchInput(q);
  const vehicleActive = parsed.kind === 'valid';
  const prefill =
    parsed.kind === 'valid' && (parsed.type === 'vin' || parsed.type === 'plate')
      ? `?${parsed.type}=${encodeURIComponent(parsed.value)}`
      : '';
  const vehicleQuery = useVehicleSearch({
    kind: 'query',
    q: vehicleActive ? parsed.value : q,
    t: vehicleActive ? parsed.type : null,
  });
  const customerQuery = useCustomerSearch(q);

  if (q.length < 2) {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertDescription>Inserisci almeno 2 caratteri per cercare.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const vehicles = vehicleQuery.data?.pages.flatMap((p) => p.data) ?? [];
  const customers = customerQuery.data?.data ?? [];

  const vehiclesEmptyDone = !vehicleActive || (vehicleQuery.isSuccess && vehicles.length === 0);
  const customersEmptyDone = customerQuery.isSuccess && customers.length === 0;
  const noErrors = !vehicleQuery.isError && !customerQuery.isError;
  const allEmpty = vehiclesEmptyDone && customersEmptyDone && noErrors;

  return (
    <div className="p-8 space-y-8">
      <div>
        <div className="text-sm text-muted-foreground mb-2">Risultati per</div>
        <div className="text-lg font-semibold text-foreground">«{q}»</div>
      </div>

      {vehicleActive && <VehiclesSection query={vehicleQuery} items={vehicles} />}
      <CustomersSection query={customerQuery} items={customers} />

      {allEmpty && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <SearchX size={48} className="mb-3" />
          <div className="font-medium text-foreground">Nessun risultato trovato.</div>
          <div className="text-sm">Verifica il dato inserito.</div>
          <Link
            to={`/vehicles/new${prefill}`}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition"
          >
            + Censisci questo veicolo
          </Link>
        </div>
      )}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-medium text-muted-foreground">{children}</h2>;
}

function SectionError({ query }: { query: { error: unknown; refetch: () => void } }) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex items-center justify-between gap-4">
        <span>{query.error instanceof Error ? query.error.message : 'Errore sconosciuto'}</span>
        <Button size="sm" variant="outline" onClick={() => query.refetch()}>
          Riprova
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function VehiclesSection({
  query,
  items,
}: {
  query: ReturnType<typeof useVehicleSearch>;
  items: VehicleSearchItem[];
}) {
  if (query.isPending) {
    return (
      <section className="space-y-3">
        <SectionHeading>Veicoli</SectionHeading>
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </section>
    );
  }
  if (query.isError) {
    return (
      <section className="space-y-3">
        <SectionHeading>Veicoli</SectionHeading>
        <SectionError query={query} />
      </section>
    );
  }
  if (items.length === 0) return null;
  return (
    <section className="space-y-3">
      <SectionHeading>Veicoli ({items.length})</SectionHeading>
      {items.map((v) => (
        <VehicleResultCard key={v.id} vehicle={v} />
      ))}
      {query.hasNextPage && (
        <Button
          variant="outline"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? 'Caricamento…' : 'Carica altri'}
        </Button>
      )}
    </section>
  );
}

function CustomersSection({
  query,
  items,
}: {
  query: ReturnType<typeof useCustomerSearch>;
  items: Customer[];
}) {
  if (query.isPending) {
    return (
      <section className="space-y-3">
        <SectionHeading>Clienti</SectionHeading>
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </section>
    );
  }
  if (query.isError) {
    return (
      <section className="space-y-3">
        <SectionHeading>Clienti</SectionHeading>
        <SectionError query={query} />
      </section>
    );
  }
  if (items.length === 0) return null;
  const hasMore = query.data?.meta.has_more ?? false;
  return (
    <section className="space-y-3">
      <SectionHeading>Clienti ({items.length})</SectionHeading>
      {items.map((c) => (
        <CustomerResultCard key={c.id} customer={c} />
      ))}
      {hasMore && (
        <p className="text-sm text-muted-foreground">
          Mostrati i primi {items.length} risultati — affina la ricerca.
        </p>
      )}
    </section>
  );
}

// Shared vehicle list used by the legacy by-customer branch (infinite list,
// no section heading).
function VehiclesList({
  query,
  items,
}: {
  query: ReturnType<typeof useVehicleSearch>;
  items: VehicleSearchItem[];
}) {
  return (
    <>
      {query.isPending && (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}
      {query.isError && <SectionError query={query} />}
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
              <VehicleResultCard key={v.id} vehicle={v} />
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
    </>
  );
}
