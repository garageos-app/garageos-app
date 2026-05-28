import { useNavigate } from 'react-router-dom';

import { CardShell } from './CardShell';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useDisputesOpen,
  type DisputeReasonCategory,
  type PendingDispute,
  type InProgressDispute,
} from '@/queries/disputesOpen';
import { formatDate } from '@/lib/format';

const REASON_LABELS_IT: Record<DisputeReasonCategory, string> = {
  not_performed: 'Lavoro non eseguito',
  wrong_data: 'Dati errati',
  not_authorized: 'Non autorizzato',
  other: 'Altro',
};

function DisputeRow({
  item,
  onClick,
}: {
  item: PendingDispute | InProgressDispute;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left text-sm py-2 px-2 rounded hover:bg-muted/50 transition flex items-center justify-between gap-2"
    >
      <span className="font-mono text-foreground shrink-0">{item.vehicleTarga}</span>
      <span className="text-muted-foreground flex-1 truncate ml-2">{item.customerName}</span>
      <span className="text-xs text-muted-foreground shrink-0 ml-2">
        {REASON_LABELS_IT[item.reasonCategory]}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums shrink-0 ml-2">
        {formatDate(item.createdAt)}
      </span>
    </button>
  );
}

export function DisputesCard() {
  const query = useDisputesOpen();
  const navigate = useNavigate();

  const state = query.isLoading
    ? 'loading'
    : query.isError
      ? 'error'
      : (query.data?.pendingResponse.count ?? 0) + (query.data?.inProgress.count ?? 0) === 0
        ? 'empty'
        : 'data';

  const pendingCount = query.data?.pendingResponse.count ?? 0;
  const inProgressCount = query.data?.inProgress.count ?? 0;
  const pendingItems = query.data?.pendingResponse.items ?? [];
  const inProgressItems = query.data?.inProgress.items ?? [];

  return (
    <CardShell
      title="Contestazioni"
      count={pendingCount}
      countBadgeVariant={pendingCount > 0 ? 'destructive' : 'default'}
      state={state}
      emptyText="Nessuna contestazione aperta"
      errorText="Errore di caricamento — riprova"
    >
      <Tabs
        defaultValue="pending"
        data-testid="disputes-tabs"
        className="flex flex-col gap-2 flex-1"
      >
        <TabsList className="w-full">
          <TabsTrigger value="pending" className="flex-1">
            Da rispondere ({pendingCount})
          </TabsTrigger>
          <TabsTrigger value="in-progress" className="flex-1">
            In corso ({inProgressCount})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="pending" className="flex flex-col gap-1">
          {pendingItems.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Nessuna contestazione aperta
            </p>
          ) : (
            pendingItems.map((i) => (
              <DisputeRow
                key={i.id}
                item={i}
                onClick={() => navigate(`/interventions/${i.interventionId}`)}
              />
            ))
          )}
        </TabsContent>
        <TabsContent value="in-progress" className="flex flex-col gap-1">
          {inProgressItems.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Nessuna contestazione aperta
            </p>
          ) : (
            inProgressItems.map((i) => (
              <DisputeRow
                key={i.id}
                item={i}
                onClick={() => navigate(`/interventions/${i.interventionId}`)}
              />
            ))
          )}
        </TabsContent>
      </Tabs>
    </CardShell>
  );
}
