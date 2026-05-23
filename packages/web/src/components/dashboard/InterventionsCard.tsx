import { useNavigate } from 'react-router-dom';

import { CardShell } from './CardShell';
import { useInterventionsRecent } from '@/queries/interventionsRecent';
import { formatDate } from '@/lib/format';

export function InterventionsCard() {
  const query = useInterventionsRecent(10);
  const navigate = useNavigate();

  const state = query.isLoading
    ? 'loading'
    : query.isError
      ? 'error'
      : (query.data?.length ?? 0) === 0
        ? 'empty'
        : 'data';

  const items = query.data ?? [];

  return (
    <CardShell
      title="Ultimi interventi"
      count={items.length}
      state={state}
      emptyText="Nessun intervento ancora registrato"
      errorText="Errore di caricamento — riprova"
    >
      <div className="flex flex-col gap-1 flex-1">
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            onClick={() => navigate(`/interventions/${i.id}`)}
            className="text-left text-sm py-2 px-2 rounded hover:bg-muted/50 transition flex items-center justify-between gap-2"
          >
            <span className="font-mono text-foreground shrink-0">{i.vehicle.plate}</span>
            <span className="text-muted-foreground flex-1 truncate ml-2">{i.summary}</span>
            <span className="text-xs text-muted-foreground shrink-0 ml-2">{i.operator.name}</span>
            <span className="text-xs text-muted-foreground tabular-nums shrink-0 ml-2">
              {formatDate(i.createdAt)}
            </span>
          </button>
        ))}
      </div>
    </CardShell>
  );
}
