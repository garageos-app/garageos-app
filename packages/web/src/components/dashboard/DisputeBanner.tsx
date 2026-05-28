import { AlertTriangle } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { useDisputesOpen } from '@/queries/disputesOpen';

export function DisputeBanner() {
  const query = useDisputesOpen();
  const pendingCount = query.data?.pendingResponse.count ?? 0;

  if (pendingCount === 0) return null;

  return (
    <Alert variant="destructive" className="sticky top-14 z-10 mb-4" data-testid="dispute-banner">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription>
        {pendingCount} {pendingCount === 1 ? 'contestazione' : 'contestazioni'} in attesa di
        risposta —{' '}
        <a
          href="#disputes-card"
          className="underline font-medium"
          onClick={(e) => {
            e.preventDefault();
            document
              .getElementById('disputes-card')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        >
          apri elenco
        </a>
      </AlertDescription>
    </Alert>
  );
}
