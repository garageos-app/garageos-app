import { useQuery } from '@tanstack/react-query';
import { Building2, Users, Wrench, Car, Contact } from 'lucide-react';
import { useApiFetch } from '@/lib/api-client';
import { StatCard } from '@/components/StatCard';
import { InterventionsTrendChart } from '@/components/InterventionsTrendChart';
import { ErrorState } from '@/components/feedback/ErrorState';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { PlatformMetrics } from '@/lib/metrics-types';

export function PlatformConsole() {
  const apiFetch = useApiFetch();

  const metricsQuery = useQuery<PlatformMetrics>({
    queryKey: ['admin-metrics'],
    queryFn: () => apiFetch<PlatformMetrics>('/v1/admin/metrics'),
  });

  const metrics = metricsQuery.data;

  if (metricsQuery.error) {
    return <ErrorState message="Errore nel caricamento delle metriche. Riprova." />;
  }

  if (metricsQuery.isLoading || !metrics) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} data-testid="stat-skeleton">
            <CardContent className="flex items-start gap-4 p-6">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-6 w-10" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <StatCard
          icon={Building2}
          label="Officine"
          value={metrics.tenants.total}
          hint={`${metrics.tenants.active} attive · ${metrics.tenants.suspended} sospese`}
        />
        <StatCard icon={Users} label="Utenti officine" value={metrics.usersTotal} />
        <StatCard
          icon={Wrench}
          label="Interventi"
          value={metrics.interventions.total}
          hint={`${metrics.interventions.last30d} ultimi 30 giorni`}
        />
        <StatCard icon={Car} label="Veicoli" value={metrics.vehiclesTotal} />
        <StatCard icon={Contact} label="Clienti" value={metrics.customersTotal} />
      </div>

      <InterventionsTrendChart data={metrics.trend} />
    </div>
  );
}
