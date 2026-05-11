import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DisputeResponseDialog } from '@/components/DisputeResponseDialog';
import { disputeReasonLabel, disputeStatusLabel, formatDate } from '@/lib/format';
import type { InterventionDispute } from '@/queries/types';

interface Props {
  interventionId: string;
  vehicleId: string;
  interventionTitle: string;
  disputes: InterventionDispute[];
}

/**
 * Read-only dispute thread for the intervention detail page. Each
 * dispute renders as a card section with customer description, reason
 * category, and (if present) the tenant's response. The "Rispondi"
 * button appears only when at least one dispute is still `open`, and
 * opens the existing DisputeResponseDialog (reused unchanged — same
 * dialog used in TimelineRow since PR #82).
 *
 * Returns null when there are no disputes — hides the card entirely.
 */
export function DisputeThreadSection({
  interventionId,
  vehicleId,
  interventionTitle,
  disputes,
}: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);

  if (disputes.length === 0) return null;

  const hasOpen = disputes.some((d) => d.status === 'open');

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Contestazione
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {disputes.map((d) => (
            <div key={d.id} className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                <span>Aperta il {formatDate(d.createdAt)}</span>
                <Badge variant="outline" className="text-[10px]">
                  {disputeReasonLabel(d.reasonCategory)}
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  {disputeStatusLabel(d.status)}
                </Badge>
              </div>
              <p className="text-sm whitespace-pre-line">{d.customerDescription}</p>
              {d.tenantResponse && (
                <div className="border-l-2 border-border pl-3 ml-2 space-y-1">
                  <div className="text-xs text-muted-foreground">
                    Risposta officina
                    {d.tenantResponseAt && ` · ${formatDate(d.tenantResponseAt)}`}
                    {d.tenantResponseUser &&
                      ` · ${d.tenantResponseUser.firstName} ${d.tenantResponseUser.lastName}`}
                  </div>
                  <p className="text-sm whitespace-pre-line">{d.tenantResponse}</p>
                </div>
              )}
            </div>
          ))}
          {hasOpen && (
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
              Rispondi alla contestazione
            </Button>
          )}
        </CardContent>
      </Card>

      {hasOpen && (
        <DisputeResponseDialog
          interventionId={interventionId}
          vehicleId={vehicleId}
          interventionTitle={interventionTitle}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}
    </>
  );
}
