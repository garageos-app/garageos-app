import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatDate, formatKm } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { DisputeResponseDialog } from '@/components/DisputeResponseDialog';
import { EditInterventionDialog } from '@/components/EditInterventionDialog';
import type { TimelineItem } from '@/queries/types';

// Timeline row con expand/collapse inline. Surfacia description,
// parts_replaced_count, attachments_count, is_disputed che il DTO
// timeline (PR vehicles-timeline) gia' contiene ma il rendering
// compact precedente non mostrava.
//
// Multi-open accordion: ogni riga ha state locale, niente coordinamento
// globale. Animazione via Tailwind grid-rows trick (no JS measure).
//
// Refactor PR #82: la row era `<button>` e conteneva il badge "Disputa".
// Per rendere il badge cliccabile (apre DisputeResponseDialog) senza
// nested button HTML invalido, la row e' ora `<div>` con due button
// fratelli — chevron toggle full-width + badge dispute standalone.

interface Props {
  item: TimelineItem;
  vehicleId: string;
}

export function TimelineRow({ item, vehicleId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [disputeDialogOpen, setDisputeDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const panelId = useId();

  const isShop = item.kind === 'shop_intervention';
  // BR-150/BR-153: other tenants' interventions are read-only — only the
  // owning officina may edit or respond to disputes. viewer_is_owner gates
  // both mutating affordances.
  const isEditable = isShop && item.status === 'active' && item.viewer_is_owner;
  const title = isShop
    ? (item.title ?? item.type.name_it)
    : (item.custom_type ?? 'Intervento privato');
  const subtitle = isShop
    ? `${item.tenant.business_name}${item.tenant.location_city ? ' · ' + item.tenant.location_city : ''}`
    : 'Cliente';
  const isDisputed = isShop && item.is_disputed;
  // The "Disputa" badge stays visible cross-tenant (status transparency),
  // but only the owner may open the response dialog.
  const canRespondToDispute = isDisputed && isShop && item.viewer_is_owner;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-4">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 flex items-center gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm min-w-0"
        >
          <div className="text-xs text-muted-foreground w-24 shrink-0">
            {formatDate(item.intervention_date)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm text-foreground truncate">{title}</div>
            <div className="text-xs text-muted-foreground truncate">
              {subtitle} · {formatKm(item.odometer_km)}
            </div>
          </div>
        </button>

        {isDisputed &&
          (canRespondToDispute ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDisputeDialogOpen(true);
              }}
              aria-label={`Apri contestazione dell'intervento del ${formatDate(item.intervention_date)}`}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
            >
              <Badge variant="destructive" className="text-[10px] cursor-pointer">
                Disputa
              </Badge>
            </button>
          ) : (
            // Cross-tenant viewer: status-only badge, no response affordance.
            <Badge variant="destructive" className="text-[10px]">
              Disputa
            </Badge>
          ))}
        <Badge variant="outline" className="text-[10px]">
          {isShop ? 'Officina' : 'Privato'}
        </Badge>

        <button
          type="button"
          aria-label={expanded ? 'Comprimi dettagli intervento' : 'Espandi dettagli intervento'}
          aria-controls={panelId}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          <ChevronDown
            size={16}
            className={cn('text-muted-foreground transition-transform', expanded && 'rotate-180')}
          />
        </button>
      </div>

      <div
        id={panelId}
        className={cn(
          'grid transition-all duration-200 ease-out',
          expanded ? 'grid-rows-[1fr] opacity-100 mt-3 pt-3 border-t' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="overflow-hidden">
          <ExpandedPanel
            item={item}
            isEditable={isEditable}
            onEditClick={() => setEditDialogOpen(true)}
          />
        </div>
      </div>

      {canRespondToDispute && (
        <DisputeResponseDialog
          interventionId={item.id}
          vehicleId={vehicleId}
          interventionTitle={title}
          open={disputeDialogOpen}
          onOpenChange={setDisputeDialogOpen}
        />
      )}
      {isEditable && item.kind === 'shop_intervention' && (
        <EditInterventionDialog
          intervention={item}
          vehicleId={vehicleId}
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
        />
      )}
    </div>
  );
}

function ExpandedPanel({
  item,
  isEditable,
  onEditClick,
}: {
  item: TimelineItem;
  isEditable: boolean;
  onEditClick: () => void;
}) {
  const description = item.description.trim();
  const isShop = item.kind === 'shop_intervention';
  const partsCount = isShop ? item.parts_replaced_count : 0;
  const hasAttachments = item.has_attachments && item.attachments_count > 0;

  return (
    <div className="space-y-3 pl-28">
      {description ? (
        <p className="text-sm text-foreground leading-relaxed whitespace-pre-line">{description}</p>
      ) : (
        <p className="text-sm italic text-muted-foreground">Nessuna descrizione.</p>
      )}
      {(partsCount > 0 || hasAttachments) && (
        <div className="flex flex-wrap gap-2">
          {partsCount > 0 && (
            <Badge variant="secondary" className="text-[11px]">
              {partsCount} ricambi
            </Badge>
          )}
          {hasAttachments && (
            <Badge variant="secondary" className="text-[11px]">
              Con allegati ({item.attachments_count})
            </Badge>
          )}
        </div>
      )}
      {isShop && (
        <div className="flex items-center gap-3 flex-wrap">
          {isEditable && (
            <button
              type="button"
              onClick={onEditClick}
              className="text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm px-1 -mx-1"
            >
              Modifica
            </button>
          )}
          <Link
            to={`/interventions/${item.id}`}
            className="text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm px-1 -mx-1"
          >
            Apri scheda
          </Link>
        </div>
      )}
    </div>
  );
}
