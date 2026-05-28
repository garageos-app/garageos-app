import { Link, useNavigate } from 'react-router-dom';

import { CardShell } from './CardShell';
import { useDeadlinesUpcoming } from '@/queries/deadlinesUpcoming';
import { formatDate } from '@/lib/format';
import { ERROR_LOAD_RETRY } from './strings';

export function ScadenzeCard() {
  const query = useDeadlinesUpcoming(7);
  const navigate = useNavigate();

  const state = query.isLoading
    ? 'loading'
    : query.isError
      ? 'error'
      : (query.data?.length ?? 0) === 0
        ? 'empty'
        : 'data';

  const all = query.data ?? [];
  const top = all.slice(0, 5);

  return (
    <CardShell
      title="Scadenze prossimi 7 giorni"
      count={all.length}
      state={state}
      emptyText="Nessuna scadenza nei prossimi 7 giorni"
      errorText={ERROR_LOAD_RETRY}
    >
      <div className="flex flex-col gap-1 flex-1">
        {top.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => navigate(`/vehicles/${d.vehicleId}`)}
            className="text-left text-sm py-2 px-2 rounded hover:bg-muted/50 transition flex items-center justify-between gap-2"
          >
            <span className="font-mono text-foreground">{d.vehicle.plate}</span>
            <span className="text-muted-foreground flex-1 truncate ml-2">
              {d.interventionType.nameIt}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatDate(d.dueDate)}
            </span>
          </button>
        ))}
        {all.length > 0 && (
          <Link
            to="/deadlines"
            className="text-xs text-primary hover:underline mt-auto pt-2 text-right"
          >
            Vedi tutte →
          </Link>
        )}
      </div>
    </CardShell>
  );
}
