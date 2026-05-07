import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useVehicleDetail } from '@/queries/vehicleDetail';
import { useInterventionTypes } from '@/queries/interventionTypes';
import { useCreateIntervention } from '@/queries/createIntervention';
import {
  transformToPayload,
  type CreateInterventionFormValues,
  type CreateInterventionPayload,
} from '@/lib/validators/intervention';
import { ApiError } from '@/lib/api-client';
import { translateError } from '@/lib/error-messages';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { InterventionForm } from '@/components/intervention-form/InterventionForm';
import { KmConfirmDialog } from '@/components/intervention-form/KmConfirmDialog';

export function InterventionCreate() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const detail = useVehicleDetail(id);
  const types = useInterventionTypes();
  const mutation = useCreateIntervention(id ?? '');
  const [kmConfirm, setKmConfirm] = useState<{
    payload: CreateInterventionPayload;
    message: string;
  } | null>(null);

  if (detail.isPending || types.isPending) {
    return (
      <div className="p-8 space-y-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertDescription>Errore caricamento veicolo.</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (types.isError) {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertDescription>Errore caricamento tipi intervento.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const v = detail.data.vehicle;

  if (v.status === 'archived') {
    // Shouldn't reach here if CTA disabled on VehicleDetail, but defensive
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertDescription>{translateError('vehicle.modification.archived', '')}</AlertDescription>
        </Alert>
      </div>
    );
  }

  async function onSubmit(values: CreateInterventionFormValues) {
    const payload = transformToPayload(values);
    try {
      await mutation.mutateAsync(payload);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409 && e.code === 'intervention.creation.odometer_decrease_warning') {
          setKmConfirm({ payload, message: e.message });
          return;
        }
        toast.error(translateError(e.code, e.message));
        return;
      }
      throw e;
    }
  }

  async function onKmConfirm() {
    if (!kmConfirm) return;
    try {
      await mutation.mutateAsync({ ...kmConfirm.payload, forceKmDecrease: true });
      setKmConfirm(null);
    } catch (e) {
      if (e instanceof ApiError) {
        toast.error(translateError(e.code, e.message));
        return;
      }
      throw e;
    }
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <button
          type="button"
          className="text-sm text-muted-foreground hover:text-foreground"
          onClick={() => navigate(`/vehicles/${id}`)}
        >
          ← Torna alla scheda
        </button>
        <h1 className="text-2xl font-bold mt-2">Registra intervento</h1>
        <p className="text-sm text-muted-foreground">
          {v.make} {v.model} · {v.plate} · <span className="font-mono">{v.garageCode}</span>
        </p>
      </div>

      <InterventionForm
        interventionTypes={types.data.data}
        registrationDate={v.registrationDate}
        onSubmit={onSubmit}
        submitting={mutation.isPending}
      />

      <KmConfirmDialog
        open={!!kmConfirm}
        message={kmConfirm?.message ?? ''}
        loading={mutation.isPending}
        onConfirm={onKmConfirm}
        onCancel={() => setKmConfirm(null)}
      />
    </div>
  );
}
