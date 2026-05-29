// IT-strings — hardcoded
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { useVehicleDetail } from '@/queries/vehicleDetail';
import { useVehicleTimeline } from '@/queries/vehicleTimeline';
import { ApiError } from '@/lib/api-client';
import { fallback } from '@/lib/format';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TimelineRow } from '@/components/TimelineRow';
import { OwnershipTransferDialog } from '@/components/OwnershipTransferDialog';
import { VehicleTagPrintButton } from '@/components/VehicleTagPrintButton';

const statusMeta: Record<string, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  certified: {
    label: 'Certificato',
    cls: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
    Icon: CheckCircle2,
  },
  pending: {
    label: 'Pending',
    cls: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900',
    Icon: Clock,
  },
  archived: {
    label: 'Archiviato',
    cls: 'bg-muted text-muted-foreground border-border',
    Icon: AlertTriangle,
  },
};

export function VehicleDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const detail = useVehicleDetail(id);
  const timeline = useVehicleTimeline(id);
  const [transferOpen, setTransferOpen] = useState(false);

  useEffect(() => {
    if (detail.isError && detail.error instanceof ApiError && detail.error.status === 404) {
      toast.error('Veicolo non trovato');
      navigate('/', { replace: true });
    }
  }, [detail.isError, detail.error, navigate]);

  if (detail.isPending) {
    return (
      <div className="p-8 space-y-6">
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>
              {detail.error instanceof Error ? detail.error.message : 'Errore sconosciuto'}
            </span>
            <Button size="sm" variant="outline" onClick={() => detail.refetch()}>
              Riprova
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const v = detail.data.vehicle;
  const customer = detail.data.currentOwnership?.customer;
  const sb = statusMeta[v.status] ?? statusMeta.pending;
  const customerName =
    customer && customer.firstName && customer.lastName
      ? `${customer.firstName} ${customer.lastName}`
      : '—';

  const timelineItems = timeline.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="p-8 space-y-8">
      <div>
        <div className="font-mono text-xs text-muted-foreground tracking-wider mb-1">
          {v.garageCode}
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">
              {v.make} {v.model}{' '}
              {v.version ? <span className="text-muted-foreground">{v.version}</span> : null}
            </h1>
            <div className="text-sm text-muted-foreground mt-1">
              VIN <span className="font-mono">{v.vin}</span> · Targa{' '}
              <span className="font-mono">{v.plate}</span> · {v.year} · {v.fuelType}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={sb.cls}>
              <sb.Icon size={14} className="mr-1" /> {sb.label}
            </Badge>
            <VehicleTagPrintButton vehicleId={v.id} tagFirstPrintedAt={v.tag_first_printed_at} />
            <Button
              onClick={() => navigate(`/vehicles/${id}/interventions/new`)}
              disabled={v.status === 'archived'}
            >
              Registra intervento
            </Button>
            {v.status === 'certified' && detail.data.currentOwnership && (
              <Button variant="outline" onClick={() => setTransferOpen(true)}>
                Trasferisci proprietà
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div className="bg-card border border-border rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Cilindrata
          </div>
          <div className="font-semibold mt-1 text-foreground">
            {v.engineDisplacement != null ? `${v.engineDisplacement} cc` : '—'}
          </div>
        </div>
        <div className="bg-card border border-border rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Potenza</div>
          <div className="font-semibold mt-1 text-foreground">
            {v.powerKw != null ? `${v.powerKw} kW` : '—'}
          </div>
        </div>
        <div className="bg-card border border-border rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Colore</div>
          <div className="font-semibold mt-1 text-foreground">{fallback(v.color)}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Cliente</div>
          <div className="font-semibold mt-1 truncate text-foreground">{customerName}</div>
        </div>
      </div>

      <section>
        <h2 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-3">
          Timeline interventi
        </h2>

        {timeline.isPending && (
          <div className="space-y-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        )}

        {timeline.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              {timeline.error instanceof Error
                ? timeline.error.message
                : 'Errore caricamento timeline'}
            </AlertDescription>
          </Alert>
        )}

        {timeline.isSuccess && timelineItems.length === 0 && (
          <div className="bg-card border border-border rounded-lg p-8 text-center text-muted-foreground">
            Nessun intervento registrato per questo veicolo.
          </div>
        )}

        {timeline.isSuccess && timelineItems.length > 0 && (
          <>
            <div className="bg-card border border-border rounded-lg divide-y divide-border">
              {timelineItems.map((item) => (
                <TimelineRow key={item.id} item={item} vehicleId={id!} />
              ))}
            </div>
            {timeline.hasNextPage && (
              <div className="pt-4">
                <Button
                  variant="outline"
                  onClick={() => timeline.fetchNextPage()}
                  disabled={timeline.isFetchingNextPage}
                >
                  {timeline.isFetchingNextPage ? 'Caricamento…' : 'Carica più interventi'}
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      {detail.data.currentOwnership?.customer && (
        <OwnershipTransferDialog
          open={transferOpen}
          onOpenChange={setTransferOpen}
          vehicleId={v.id}
          vehicleLabel={v.plate ?? v.garageCode ?? v.id}
          currentOwnerCustomerId={detail.data.currentOwnership.customer.id}
        />
      )}
    </div>
  );
}
