// IT-strings — hardcoded, no i18n in demo-2
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, SearchX } from 'lucide-react';

import { useCustomersList } from '@/queries/customersList';
import { CreateCustomerDialog } from '@/components/customers/CreateCustomerDialog';
import { customerDisplayName } from '@/lib/customer-display';
import { formatDate } from '@/lib/format';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import type { CustomerListItem } from '@/queries/types';

export function CustomerList() {
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const debouncedQ = useDebouncedValue(q, 300);
  const query = useCustomersList(debouncedQ);
  const navigate = useNavigate();

  const items: CustomerListItem[] = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Users size={24} className="text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Clienti</h1>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Nuovo cliente</Button>
      </div>

      <CreateCustomerDialog open={createOpen} onOpenChange={setCreateOpen} />

      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Cerca per nome o ragione sociale"
        className="w-72"
      />

      {query.isPending && (
        <div className="space-y-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
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
          <div className="font-medium text-foreground">Nessun cliente trovato.</div>
        </div>
      )}

      {query.isSuccess && items.length > 0 && (
        <div className="overflow-x-auto">
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="px-4 py-3 font-semibold">Nome</th>
                  <th className="px-4 py-3 font-semibold">Telefono</th>
                  <th className="px-4 py-3 font-semibold text-right">Veicoli</th>
                  <th className="px-4 py-3 font-semibold">Ultimo intervento</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => navigate(`/customers/${c.id}`)}
                    className="cursor-pointer hover:bg-muted/50 transition"
                  >
                    <td className="px-4 py-3 font-medium text-foreground">
                      {customerDisplayName(c)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{c.phone ?? '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{c.vehicleCount}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {c.lastInterventionAt ? formatDate(c.lastInterventionAt) : 'Nessuno'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {query.hasNextPage && (
        <div className="pt-2">
          <Button
            variant="outline"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? 'Caricamento…' : 'Carica altre'}
          </Button>
        </div>
      )}
    </div>
  );
}
