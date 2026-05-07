// IT-strings — hardcoded
import { useSearchParams } from 'react-router-dom';
import { SearchX } from 'lucide-react';
import { useVehicleSearch } from '@/queries/vehicleSearch';
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
};

function isValidType(t: string | null): t is SearchType {
  return t === 'vin' || t === 'plate' || t === 'garage_code';
}

export function SearchResults() {
  const [params] = useSearchParams();
  const q = params.get('q')?.trim() ?? '';
  const tRaw = params.get('t');
  const t = isValidType(tRaw) ? tRaw : null;

  const query = useVehicleSearch({ q, t });
  const items = query.data?.pages.flatMap((p) => p.data) ?? [];

  if (!q || !t) {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertDescription>Parametri di ricerca mancanti o invalidi.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div>
        <div className="text-sm text-muted-foreground mb-2">
          Ricerca per <Badge variant="outline">{typeLabel[t]}</Badge>
        </div>
        <div className="font-mono text-lg font-semibold text-foreground">{q}</div>
      </div>

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
    </div>
  );
}
