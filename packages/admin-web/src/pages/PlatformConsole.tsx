import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-client';
import { StatCard } from '@/components/StatCard';
import { InterventionsTrendChart } from '@/components/InterventionsTrendChart';
import type { PlatformMetrics } from '@/lib/metrics-types';

export function PlatformConsole() {
  const apiFetch = useApiFetch();

  const metricsQuery = useQuery<PlatformMetrics>({
    queryKey: ['admin-metrics'],
    queryFn: () => apiFetch<PlatformMetrics>('/v1/admin/metrics'),
  });

  const metrics = metricsQuery.data;

  return (
    <div className="space-y-8">
      {metricsQuery.isLoading && <p className="text-muted-foreground">Caricamento metriche...</p>}

      {metricsQuery.error && (
        <div role="alert" className="p-4 rounded-md bg-destructive/10 text-destructive">
          Errore nel caricamento delle metriche. Riprova.
        </div>
      )}

      {!metricsQuery.isLoading && !metricsQuery.error && metrics && (
        <div className="space-y-8">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <StatCard
              label="Officine"
              value={metrics.tenants.total}
              hint={`${metrics.tenants.active} attive · ${metrics.tenants.suspended} sospese`}
            />
            <StatCard label="Utenti officine" value={metrics.usersTotal} />
            <StatCard
              label="Interventi"
              value={metrics.interventions.total}
              hint={`${metrics.interventions.last30d} ultimi 30 giorni`}
            />
            <StatCard label="Veicoli" value={metrics.vehiclesTotal} />
            <StatCard label="Clienti" value={metrics.customersTotal} />
          </div>

          <InterventionsTrendChart data={metrics.trend} />
        </div>
      )}
    </div>
  );
}
