// IT-strings — hardcoded
import { useState } from 'react';
import { Calendar, SearchX } from 'lucide-react';

import { useDeadlinesList } from '@/queries/deadlinesList';
import { useInterventionTypes } from '@/queries/interventionTypes';
import { groupByDueBucket } from '@/lib/deadline-grouping';
import { DeadlineRow } from '@/components/DeadlineRow';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TenantDeadline } from '@/queries/types';

// F-OFF-402 dashboard. Frontend bucket-izza per dueDate ranges su
// `today` corrente; "overdue" è derivato (`dueDate < today &&
// status === 'open'`) perché nessun cron aggiorna lo status enum
// `overdue` oggi.

const ALL_TYPES = '__all__';

export function DeadlineDashboard() {
  const [interventionTypeId, setInterventionTypeId] = useState<string>(ALL_TYPES);
  const types = useInterventionTypes();
  const query = useDeadlinesList({
    interventionTypeId: interventionTypeId === ALL_TYPES ? undefined : interventionTypeId,
  });

  const items: TenantDeadline[] = query.data?.pages.flatMap((p) => p.deadlines) ?? [];
  const today = startOfDayLocal(new Date());
  const buckets = groupByDueBucket(items, today);

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <Calendar size={24} className="text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Scadenze in arrivo</h1>
      </div>

      <div>
        <Select value={interventionTypeId} onValueChange={setInterventionTypeId}>
          <SelectTrigger className="w-72">
            <SelectValue placeholder="Tutti i tipi" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TYPES}>Tutti i tipi</SelectItem>
            {types.data?.data.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.nameIt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {query.isPending && (
        <div className="space-y-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
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
          <div className="font-medium text-foreground">
            {interventionTypeId === ALL_TYPES
              ? 'Nessuna scadenza configurata.'
              : 'Nessuna scadenza per il tipo selezionato.'}
          </div>
        </div>
      )}

      {query.isSuccess && items.length > 0 && (
        <div className="space-y-6">
          <BucketSection title="Scadute" tone="destructive" items={buckets.overdue} />
          <BucketSection title="Questa settimana" items={buckets.thisWeek} />
          <BucketSection title="Questo mese" items={buckets.thisMonth} />
          <BucketSection title="Prossimi 3 mesi" items={buckets.threeMonths} />
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

interface BucketSectionProps {
  title: string;
  items: TenantDeadline[];
  tone?: 'destructive';
}

function BucketSection({ title, items, tone }: BucketSectionProps) {
  return (
    <section>
      <div
        className={
          tone === 'destructive'
            ? 'text-xs uppercase tracking-wider font-semibold text-destructive mb-2'
            : 'text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-2'
        }
      >
        {title} ({items.length})
      </div>
      {items.length === 0 ? (
        <div className="bg-card border border-border rounded-lg p-4 text-sm text-muted-foreground">
          Nessuna scadenza in questa fascia.
        </div>
      ) : (
        <div className="bg-card border border-border rounded-lg divide-y divide-border">
          {items.map((d) => (
            <DeadlineRow key={d.id} item={d} />
          ))}
        </div>
      )}
    </section>
  );
}

function startOfDayLocal(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}
