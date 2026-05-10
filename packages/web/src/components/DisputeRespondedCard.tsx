import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDate, disputeReasonLabel, disputeStatusLabel } from '@/lib/format';
import type { InterventionDispute } from '@/queries/types';

interface Props {
  dispute: InterventionDispute;
}

export function DisputeRespondedCard({ dispute }: Props) {
  const responder = dispute.tenantResponseUser
    ? `${dispute.tenantResponseUser.firstName} ${dispute.tenantResponseUser.lastName}`
    : null;
  const respondedAtFormatted = dispute.tenantResponseAt
    ? formatDate(dispute.tenantResponseAt)
    : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Badge variant="outline">{disputeReasonLabel(dispute.reasonCategory)}</Badge>
            <Badge variant="secondary">{disputeStatusLabel(dispute.status)}</Badge>
          </div>
          <span className="text-xs text-muted-foreground">{formatDate(dispute.createdAt)}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Cliente</div>
          <p className="whitespace-pre-line">{dispute.customerDescription}</p>
        </div>

        {dispute.tenantResponse && (
          <div className="border-l-4 border-secondary pl-3 py-2 bg-secondary/30 rounded-r-sm">
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Officina{respondedAtFormatted ? ` · ${respondedAtFormatted}` : ''}
              {responder ? ` · ${responder}` : ''}
            </div>
            <p className="whitespace-pre-line">{dispute.tenantResponse}</p>
          </div>
        )}

        {dispute.status === 'resolved_by_cancellation' && (
          <p className="text-xs italic text-muted-foreground">
            Intervento cancellato — la contestazione è stata chiusa di conseguenza.
          </p>
        )}
        {(dispute.status === 'escalated' || dispute.status === 'closed_by_admin') && (
          <p className="text-xs italic text-muted-foreground">
            Gestita dall'amministrazione GarageOS.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
