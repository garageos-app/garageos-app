import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate } from '@/lib/format';
import type { InterventionRevision } from '@/queries/types';

interface Props {
  revisions: InterventionRevision[];
}

// Maps PATCH-mutable field names to Italian display labels.
// See BR-064/BR-065 for the list of auditable fields on interventions.
const fieldLabels: Record<string, string> = {
  title: 'Titolo',
  description: 'Descrizione',
  internalNotes: 'Note interne',
  partsReplaced: 'Ricambi sostituiti',
  interventionTypeId: 'Tipo intervento',
};

function formatChangeValue(v: unknown): string {
  if (v == null) return '∅';
  if (Array.isArray(v)) return `${v.length} elementi`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Type guard for the { before, after } diff shape emitted by the PATCH route.
// `changes` is typed as Record<string, unknown> (opaque) so we guard defensively
// rather than casting.
function isBeforeAfter(v: unknown): v is { before: unknown; after: unknown } {
  return typeof v === 'object' && v !== null && 'before' in v && 'after' in v;
}

/**
 * Audit log of BR-064/BR-065 revisions for an intervention. Rendered DESC
 * (most recent first). Officina-only — surfaces operator name and free-form
 * reason text.
 *
 * First UI consumer of GET /v1/interventions/:id/revisions shipped in PR #26.
 *
 * Returns null when no revisions exist so the card is hidden for interventions
 * that have never been edited, keeping the page uncluttered.
 */
export function RevisionHistorySection({ revisions }: Props) {
  if (revisions.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Cronologia modifiche ({revisions.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {revisions.map((r) => (
          <div
            key={r.id}
            data-testid="revision-entry"
            className="border-l-2 border-border pl-3 space-y-1"
          >
            <div className="text-xs text-muted-foreground">
              {formatDate(r.revised_at)}
              {' · '}
              {r.user.first_name} {r.user.last_name}
              {r.reason && (
                <span>
                  {' '}
                  · Motivo: <span className="italic">{r.reason}</span>
                </span>
              )}
            </div>
            <ul className="text-sm space-y-0.5">
              {Object.entries(r.changes).map(([field, change]) => {
                const label = fieldLabels[field] ?? field;
                if (isBeforeAfter(change)) {
                  return (
                    <li key={field}>
                      <span className="text-muted-foreground">{label}:</span>{' '}
                      <span className="line-through text-muted-foreground">
                        {formatChangeValue(change.before)}
                      </span>
                      {' → '}
                      <span className="font-medium">{formatChangeValue(change.after)}</span>
                    </li>
                  );
                }
                return (
                  <li key={field}>
                    <span className="text-muted-foreground">{label}:</span>{' '}
                    {formatChangeValue(change)}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
