// ReactivateSection — F-OFF-004 reactivation slice (BR-212).
//
// Section embedded in EditUserDialog when user.status === 'inactive'.
// 2-step UI: primary button → confirm step con preview.
//
// Submits POST /v1/users/:id/reactivate via useReactivateUser hook.

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { useReactivateUser, type AdminUser, type ReactivateUserBody } from '@/queries/users-admin';

const ROLE_LABEL: Record<'super_admin' | 'mechanic', string> = {
  super_admin: 'Super Admin',
  mechanic: 'Meccanico',
};

interface Props {
  user: AdminUser;
  onSuccess: () => void;
}

export function ReactivateSection({ user, onSuccess }: Props) {
  const reactivateMut = useReactivateUser();

  const [confirming, setConfirming] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const confirmDisabled = reactivateMut.isPending;

  async function handleConfirm() {
    setErrorMessage(null);
    const body: ReactivateUserBody = {};
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
