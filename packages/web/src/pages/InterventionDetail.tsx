// IT-strings — hardcoded (officina-only page)
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { useInterventionDetail } from '@/queries/interventionDetail';
import { useInterventionDisputes } from '@/queries/interventionDisputes';
import { useInterventionRevisions } from '@/queries/interventionRevisions';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { InterventionHeader } from '@/components/intervention-detail/InterventionHeader';
import { AttachmentsSection } from '@/components/intervention-detail/AttachmentsSection';
import { DisputeThreadSection } from '@/components/intervention-detail/DisputeThreadSection';
import { RevisionHistorySection } from '@/components/intervention-detail/RevisionHistorySection';
import { CancelInterventionDialog } from '@/components/CancelInterventionDialog';
import { EditInterventionDialog } from '@/components/EditInterventionDialog';
import type {
  InterventionDetail as InterventionDetailDto,
  ShopTimelineItem,
} from '@/queries/types';

// ---------------------------------------------------------------------------
// Adapter: InterventionDetailDto → ShopTimelineItem
// ---------------------------------------------------------------------------

// EditInterventionDialog (PR #83) was written when the only entry point
// was the vehicle timeline row, so it expects a ShopTimelineItem. The
// InterventionDetail DTO is a strict superset: every field that
// ShopTimelineItem exposes is present on the detail DTO, so the mapping
// is total and lossless for the dialog's purposes. Parts/internalNotes
// are not exposed on ShopTimelineItem — the dialog already handles that
// case with "defaults at empty + collapsed sections" (see PR #83 comment).
function toTimelineItemSlice(d: InterventionDetailDto): ShopTimelineItem {
  return {
    kind: 'shop_intervention',
    id: d.id,
    intervention_date: d.intervention_date,
    odometer_km: d.odometer_km,
    type: d.type,
    title: d.title,
    description: d.description,
    parts_replaced_count: d.parts_replaced.length,
    status: d.status,
    is_disputed: d.is_disputed,
    wiki_window_open: d.wiki_window_open,
    tenant: {
      id: d.tenant.id,
      business_name: d.tenant.business_name,
    },
    viewer_is_owner: d.viewer_is_owner,
    has_attachments: d.attachments.length > 0,
    attachments_count: d.attachments.length,
  };
}

// ---------------------------------------------------------------------------
// Stats tile (shared within this module)
// ---------------------------------------------------------------------------

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-semibold mt-1 text-foreground truncate">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

/**
 * Intervention detail page (F-OFF-301). Officina-only.
 *
 * Mounts three React Queries (detail, disputes, revisions) and composes
 * InterventionHeader, a 4-tile stats grid, a wiki banner (BR-062), and
 * six Card sections (Descrizione, Ricambi, Allegati, Contestazione,
 * Cronologia modifiche, Annullamento). Hosts CancelInterventionDialog
 * (BR-066) and EditInterventionDialog (BR-062/BR-064). The edit dialog
 * is reused from PR #83 unchanged via the `toTimelineItemSlice` adapter.
 *
 * 404 on the detail query navigates back to '/' with a toast (same
 * pattern as VehicleDetail, CustomerDetail). Disputes/revisions errors
 * are surfaced inline by the section components — the page remains
 * usable if secondary queries fail.
 */
export function InterventionDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // See note on useInterventionDisputes: the hook already unwraps the
  // wire envelope { disputes: [...] } and returns InterventionDispute[]
  // directly. Use disputes.data ?? [] (NOT disputes.data?.disputes ?? []).
  const detail = useInterventionDetail(id);
  // Preloaded on mount (not lazy) — detail page shows disputes inline,
  // unlike the timeline row which loads them only when the dialog opens.
  // Both are owner-only surfaces (BR-151/BR-153) and are gated out of the
  // render tree below when viewer_is_owner is false; the server also redacts
  // revisions and tenant-scopes disputes, so a cross-tenant fetch is harmless.
  const disputes = useInterventionDisputes(id);
  const revisions = useInterventionRevisions(id);

  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  // 404 → toast + navigate back to dashboard. Pattern mirrors VehicleDetail.
  useEffect(() => {
    if (detail.isError && detail.error instanceof ApiError && detail.error.status === 404) {
      toast.error('Intervento non trovato.');
      navigate('/', { replace: true });
    }
  }, [detail.isError, detail.error, navigate]);

  // --- Loading state ---
  if (detail.isPending) {
    return (
      <div className="p-4 md:p-8 space-y-6" data-testid="detail-skeleton">
        <Skeleton className="h-32" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  // --- Non-404 error state (404 already redirected above) ---
  if (detail.isError) {
    return (
      <div className="p-4 md:p-8">
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>
              {detail.error instanceof Error ? detail.error.message : 'Errore sconosciuto.'}
            </span>
            <Button size="sm" variant="outline" onClick={() => detail.refetch()}>
              Riprova
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // --- Success state ---
  const i = detail.data;
  const disputeList = disputes.data ?? [];
  const revisionList = revisions.data?.data ?? [];

  return (
    <div className="p-4 md:p-8 space-y-6">
      {/* BR-150/BR-153: cross-tenant read-only notice. Shown when the
          intervention belongs to another officina — note interne e identità
          operatore sono nascoste, e le azioni di modifica non disponibili. */}
      {!i.viewer_is_owner && (
        <Alert>
          <AlertDescription>
            <strong>Sola lettura</strong> · questo intervento è stato registrato da{' '}
            {i.tenant.business_name}. Note interne e dati operatore non sono visibili e non è
            possibile modificarlo.
          </AlertDescription>
        </Alert>
      )}

      {/* Header: back link, title, type subtitle, date/km, badges, action
          buttons (Modifica + Annulla are gated to status==='active' inside
          InterventionHeader — BR-066/BR-128). */}
      <InterventionHeader
        intervention={i}
        onEditClick={() => setEditOpen(true)}
        onCancelClick={() => setCancelOpen(true)}
      />

      {/* 3-tile stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Tile label="Officina" value={i.tenant.business_name} />
        <Tile
          label="Operatore"
          value={i.created_by ? `${i.created_by.first_name} ${i.created_by.last_name}` : '—'}
        />
        <Tile label="Creato il" value={formatDate(i.created_at)} />
      </div>

      {/* BR-062 wiki banner — shown only when intervention is still
          active. wiki_window_open is a server-computed boolean that
          encapsulates the 3-condition predicate (timestamp + customer
          first-seen + explicit lock). Lesson: never re-derive this
          client-side (feedback_compute_composite_br_predicates_server_side.md). */}
      {i.status === 'active' &&
        i.viewer_is_owner &&
        (i.wiki_window_open ? (
          <Alert>
            <AlertDescription>
              <strong>Modifiche libere</strong> · le modifiche entro le 48 ore dalla creazione non
              sono visibili al cliente.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <AlertDescription>
              <strong>Audit attivo</strong> · ogni modifica richiede una motivazione e sarà visibile
              al cliente.
            </AlertDescription>
          </Alert>
        ))}

      {/* Descrizione card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Descrizione
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {i.description ? (
            <p className="text-sm whitespace-pre-line">{i.description}</p>
          ) : (
            <p className="text-sm italic text-muted-foreground">Nessuna descrizione.</p>
          )}
          {/* BR-065: internal_notes are officina-only (not surfaced to customer). */}
          {i.internal_notes && (
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                Note interne (BR-065)
              </div>
              <p className="text-sm whitespace-pre-line">{i.internal_notes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ricambi card — hidden when empty */}
      {i.parts_replaced.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Ricambi sostituiti ({i.parts_replaced.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {i.parts_replaced.map((p, idx) => (
                <li key={idx}>
                  <span className="font-medium">{p.name}</span>
                  {p.code && <span className="text-muted-foreground"> · codice {p.code}</span>}
                  <span className="text-muted-foreground"> ×{p.quantity}</span>
                  {p.notes && <span className="text-muted-foreground"> · {p.notes}</span>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Allegati — list visible to all; upload affordance owner-only */}
      <AttachmentsSection
        attachments={i.attachments}
        interventionId={i.id}
        canUpload={i.viewer_is_owner}
      />

      {/* Contestazione thread + cronologia modifiche — owner-only surfaces
          (BR-151/BR-153). Hidden in the cross-tenant read-only view: the
          dispute response is an owner mutation and the revision audit trail
          carries operator identity + internalNotes diffs. */}
      {i.viewer_is_owner && (
        <>
          {/* DisputeThreadSection / RevisionHistorySection return null when empty */}
          <DisputeThreadSection
            interventionId={i.id}
            vehicleId={i.vehicle.id}
            interventionTitle={i.title ?? i.type.name_it}
            disputes={disputeList}
          />
          <RevisionHistorySection revisions={revisionList} />
        </>
      )}

      {/* Annullamento card — shown only when intervention is cancelled */}
      {i.status === 'cancelled' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Annullamento
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {i.cancelled_at && (
              <div className="text-xs text-muted-foreground">
                Annullato il {formatDate(i.cancelled_at)}
              </div>
            )}
            {i.cancelled_reason && <p className="text-sm">{i.cancelled_reason}</p>}
          </CardContent>
        </Card>
      )}

      {/* Dialogs — always mounted (portal-based), visibility controlled
          by open prop. CancelInterventionDialog uses its own
          useCancelIntervention mutation internally. EditInterventionDialog
          is fed a ShopTimelineItem slice via the adapter above. */}
      <CancelInterventionDialog
        interventionId={i.id}
        open={cancelOpen}
        onOpenChange={setCancelOpen}
      />
      <EditInterventionDialog
        intervention={toTimelineItemSlice(i)}
        vehicleId={i.vehicle.id}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </div>
  );
}
