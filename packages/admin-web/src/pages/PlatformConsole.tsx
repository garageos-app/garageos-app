import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApiFetch } from '@/lib/api-client';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/StatCard';
import { InterventionsTrendChart } from '@/components/InterventionsTrendChart';
import type { PlatformMetrics } from '@/lib/metrics-types';

// Shape returned by GET /v1/admin/me — all fields always present (default '').
interface AdminMe {
  sub: string;
  email: string;
  firstName: string;
  lastName: string;
}

export function PlatformConsole() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const apiFetch = useApiFetch();

  const meQuery = useQuery<AdminMe>({
    queryKey: ['admin-me'],
    queryFn: () => apiFetch<AdminMe>('/v1/admin/me'),
  });

  const metricsQuery = useQuery<PlatformMetrics>({
    queryKey: ['admin-metrics'],
    queryFn: () => apiFetch<PlatformMetrics>('/v1/admin/metrics'),
  });

  const displayName = meQuery.data
    ? [meQuery.data.firstName, meQuery.data.lastName].filter(Boolean).join(' ') ||
      meQuery.data.email
    : undefined;

  const metrics = metricsQuery.data;

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold">Console piattaforma</h1>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => navigate('/officine')}>
              Officine
            </Button>
            <Button onClick={() => navigate('/officine/nuova')}>Crea officina</Button>
            <Button variant="outline" onClick={signOut}>
              Esci
            </Button>
          </div>
        </div>

        {meQuery.data && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>{displayName}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{meQuery.data.email}</p>
            </CardContent>
          </Card>
        )}

        {meQuery.error && (
          <div role="alert" className="p-4 rounded-md bg-destructive/10 text-destructive mb-8">
            Errore nel caricamento del profilo. Riprova.
          </div>
        )}

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
    </div>
  );
}
