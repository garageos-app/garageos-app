// ReactivateSection — F-OFF-004 reactivation slice (BR-212).
//
// Section embedded in EditUserDialog when user.status === 'inactive'.
// 2-step UI: primary button → confirm step con preview + Select condizionale
// se la sede originale (user.locationId) non è più active nel tenant.
//
// Submits POST /v1/users/:id/reactivate via useReactivateUser hook.

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api-client';
import {
  useReactivateUser,
  type AdminUser,
  type TenantLocation,
  type ReactivateUserBody,
} from '@/queries/users-admin';

const ROLE_LABEL: Record<'super_admin' | 'mechanic', string> = {
  super_admin: 'Super Admin',
  mechanic: 'Meccanico',
};

interface Props {
  user: AdminUser;
  locations: TenantLocation[];
  onSuccess: () => void;
}

export function ReactivateSection({ user, locations, onSuccess }: Props) {
  const reactivateMut = useReactivateUser();

  const [confirming, setConfirming] = useState(false);
  const [overrideLocationId, setOverrideLocationId] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Derive current location from the locations list (AdminUser carries only
  // locationId — name is resolved client-side).
  const currentLocation = locations.find((l) => l.id === user.locationId);
  const locationDisplayName = currentLocation?.name ?? '—';

  // Stale = mechanic with a locationId pointing to a location that is no longer
  // present in the tenant's active locations list. Super admins keep null
  // locationId per BR-204, so they never appear stale here.
  const locationStale = user.role === 'mechanic' && user.locationId !== null && !currentLocation;

  const confirmDisabled = reactivateMut.isPending || (locationStale && !overrideLocationId);

  async function handleConfirm() {
    setErrorMessage(null);
    const body: ReactivateUserBody = overrideLocationId ? { locationId: overrideLocationId } : {};
    try {
      await reactivateMut.mutateAsync({ id: user.id, body });
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else if (
        typeof err === 'object' &&
        err !== null &&
        'message' in err &&
        typeof (err as { message: unknown }).message === 'string'
      ) {
        setErrorMessage((err as { message: string }).message);
      } else {
        setErrorMessage('Errore imprevisto, riprova.');
      }
      // Stay on confirm step so the user can retry or cancel.
    }
  }

  function handleCancel() {
    setConfirming(false);
    setOverrideLocationId('');
    setErrorMessage(null);
  }

  return (
    <section data-testid="reactivate-section">
      <h3 className="font-medium mb-3">Riattiva utente</h3>

      <div className="text-sm text-muted-foreground space-y-1 mb-3">
        <p>
          <span className="font-medium text-foreground">Email:</span> {user.email}
        </p>
        <p>
          <span className="font-medium text-foreground">Ruolo:</span> {ROLE_LABEL[user.role]}
        </p>
        <p>
          <span className="font-medium text-foreground">Sede:</span> {locationDisplayName}
        </p>
      </div>

      {errorMessage && (
        <div
          className="border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 rounded-md p-3 text-sm mb-3"
          role="alert"
          data-testid="reactivate-error"
        >
          {errorMessage}
        </div>
      )}

      {!confirming ? (
        <Button size="sm" onClick={() => setConfirming(true)} data-testid="reactivate-button">
          Riattiva utente
        </Button>
      ) : (
        <div className="space-y-3">
          {locationStale && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Sede non valida o inattiva. Seleziona una nuova sede:
              </p>
              <Select value={overrideLocationId} onValueChange={(v) => setOverrideLocationId(v)}>
                <SelectTrigger id="reactivate-location" data-testid="reactivate-location-select">
                  <SelectValue placeholder="Seleziona sede…" />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id}>
                      {loc.name}
                      {loc.city ? ` — ${loc.city}` : ''}
                      {loc.isPrimary ? ' (principale)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={confirmDisabled}
              onClick={() => void handleConfirm()}
              data-testid="reactivate-confirm-button"
            >
              {reactivateMut.isPending ? 'Riattivazione…' : 'Conferma riattivazione'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={reactivateMut.isPending}
              onClick={handleCancel}
            >
              Annulla
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
