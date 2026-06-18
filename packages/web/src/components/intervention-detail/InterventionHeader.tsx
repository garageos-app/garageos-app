import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useHasRole } from '@/auth/useHasRole';
import { formatDate, formatKm } from '@/lib/format';
import type { InterventionDetail } from '@/queries/types';
import { InterventionExportPdfButton } from './InterventionExportPdfButton';

interface Props {
  intervention: InterventionDetail;
  onEditClick: () => void;
  onCancelClick: () => void;
}

/**
 * Top section of the intervention detail page. Shows back link to the
 * vehicle, garage_code + plate crumb, title (or type fallback), type
 * subtitle, date + km, status badges (cancelled / disputed), and action
 * buttons (Modifica + Annulla) gated to status === 'active'.
 *
 * Backend gates action permissions (BR-066 super_admin, BR-128
 * disputed/cancelled hides edit). The "Annulla" button is now gated
 * pre-emptively via `useHasRole('super_admin')` (slice I) — mechanic
 * users do not see it, eliminating the 403-toast roundtrip for the
 * common no-permission case. Backend remains source of truth: stale
 * tokens with downgraded roles still surface 403 via toast on submit.
 */
export function InterventionHeader({ intervention: i, onEditClick, onCancelClick }: Props) {
  const isActive = i.status === 'active';
  // BR-150/BR-153: a non-owning tenant sees the intervention read-only —
  // edit/cancel are owner-only mutations, hidden cross-tenant.
  const isOwner = i.viewer_is_owner;
  const canCancel = useHasRole('super_admin'); // BR-066
  const title = i.title ?? i.type.name_it;
  const vehicleHref = `/vehicles/${i.vehicle.id}`;

  return (
    <div className="space-y-4">
      <Link
        to={vehicleHref}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <ArrowLeft size={14} /> Torna alla scheda veicolo
      </Link>

      <div className="font-mono text-xs text-muted-foreground tracking-wider">
        {i.vehicle.garage_code} · {i.vehicle.plate}
      </div>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{title}</h1>
          <div className="text-sm text-muted-foreground mt-1">
            {i.type.name_it} · {formatDate(i.intervention_date)} · {formatKm(i.odometer_km)}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {i.status === 'cancelled' && <Badge variant="outline">Cancellato</Badge>}
          {i.is_disputed && <Badge variant="destructive">Disputa</Badge>}
          {!isOwner && <Badge variant="outline">Sola lettura</Badge>}
          {isActive && isOwner && (
            <>
              <Button variant="outline" size="sm" onClick={onEditClick}>
                Modifica
              </Button>
              {canCancel && (
                <Button variant="outline" size="sm" onClick={onCancelClick}>
                  Annulla
                </Button>
              )}
            </>
          )}
          <InterventionExportPdfButton interventionId={i.id} />
        </div>
      </div>
    </div>
  );
}
