// IT-strings — hardcoded, no i18n in this app.
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useApiFetch, ApiError } from '@/lib/api-client';
import {
  VISIBILITY_ERROR_MESSAGES,
  GENERIC_VISIBILITY_ERROR,
  type TypeVisibility,
} from '@/lib/catalog-visibility-types';
import { PageHeader } from '@/components/layout/PageHeader';
import { ErrorState } from '@/components/feedback/ErrorState';
import { EmptyState } from '@/components/feedback/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

// Back link shared by every early-return branch — mirrors TenantDetail.tsx.
function BackLink({ tenantId }: { tenantId: string }) {
  return (
    <Link
      to={`/officine/${tenantId}`}
      className="text-sm text-muted-foreground hover:underline inline-block"
    >
      ← Torna all&apos;officina
    </Link>
  );
}

function visibleTypeIdsFrom(types: TypeVisibility[]): Set<string> {
  return new Set(types.filter((t) => t.visible).map((t) => t.id));
}

function visibleItemIdsFrom(types: TypeVisibility[]): Set<string> {
  return new Set(types.flatMap((t) => t.checklistItems.filter((i) => i.visible).map((i) => i.id)));
}

export function TenantCatalogVisibility() {
  // id is always defined when this component is mounted via
  // <Route path="/officine/:id/visibilita-catalogo" />.
  const { id } = useParams<{ id: string }>();
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery<{ data: { types: TypeVisibility[] } }>({
    queryKey: ['admin-tenant-visibility', id],
    queryFn: () => apiFetch(`/v1/admin/tenants/${id}/catalog-visibility`),
    enabled: !!id,
  });

  // ── Local Set state for visible types/items ─────────────────────────────────
  // Initialized from the query data and re-synced whenever a *new* server
  // response arrives (e.g. after Save invalidates the cache). We compare
  // against `syncedData` (not a ref/effect) so this runs during render — the
  // React-documented pattern for "adjust state when a prop changes" without
  // an extra effect-triggered re-render/flicker.
  //
  // `syncedData` MUST be seeded with a sentinel (`undefined`), never with
  // `data` itself: on a warm-cache remount (e.g. navigating back to this
  // page), `data` is already populated on the very FIRST render because
  // react-query serves it synchronously from cache. Seeding `useState(data)`
  // would make `syncedData === data` immediately, so the sync guard below
  // never fires and `visibleTypeIds`/`visibleItemIds` stay empty Sets —
  // every checkbox renders unchecked and Save would persist a full catalog
  // exclusion. `undefined` can never equal a defined `data` object, so the
  // guard always fires on first render, cold or warm.
  const [visibleTypeIds, setVisibleTypeIds] = useState<Set<string>>(new Set());
  const [visibleItemIds, setVisibleItemIds] = useState<Set<string>>(new Set());
  const [syncedData, setSyncedData] = useState<typeof data>(undefined);

  if (data && data !== syncedData) {
    setSyncedData(data);
    setVisibleTypeIds(visibleTypeIdsFrom(data.data.types));
    setVisibleItemIds(visibleItemIdsFrom(data.data.types));
  }

  function toggleType(typeId: string) {
    setVisibleTypeIds((prev) => {
      const next = new Set(prev);
      if (next.has(typeId)) next.delete(typeId);
      else next.add(typeId);
      return next;
    });
  }

  function toggleItem(itemId: string) {
    setVisibleItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  // ── Shared error handler (mirrors TenantDetail.tsx:151-160) ─────────────────
  function handleMutationError(err: unknown) {
    if (err instanceof ApiError) {
      // api-client already fired toast.error('Sessione scaduta…') and signed the
      // user out for these codes — do not stack a second contradictory toast.
      if (err.code === 'auth.expired' || err.code === 'auth.no_token') return;
      toast.error(VISIBILITY_ERROR_MESSAGES[err.code] ?? GENERIC_VISIBILITY_ERROR);
    } else {
      toast.error(GENERIC_VISIBILITY_ERROR);
    }
  }

  const saveMutation = useMutation({
    mutationFn: (body: { excludedTypeIds: string[]; excludedItemIds: string[] }) =>
      apiFetch(`/v1/admin/tenants/${id}/catalog-visibility`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-tenant-visibility', id] });
      toast.success('Visibilità aggiornata.');
    },
    onError: handleMutationError,
  });

  // ── Guards ────────────────────────────────────────────────────────────────────

  // Error check first — when the query fails, isLoading is false but data is
  // also undefined, so we must check error before the isLoading||!data guard.
  // Mirrors the guard order in TenantDetail.tsx.
  if (error) {
    return (
      <div className="max-w-3xl space-y-4">
        <BackLink tenantId={id!} />
        <ErrorState message="Errore nel caricamento della visibilità catalogo." />
      </div>
    );
  }

  // Loading state — also guards against offline/paused state where data may be
  // undefined even though isLoading is false.
  // See [[feedback_react_query_data_bang_offline_paused]].
  if (isLoading || !data) {
    return (
      <div className="max-w-3xl space-y-4">
        <BackLink tenantId={id!} />
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  function handleSave() {
    // TS does not narrow `data` across the isLoading||!data guard above into
    // this nested function declaration, even though it is only reachable
    // after that guard has passed (the Save button only renders below it).
    if (!data) return;
    const excludedTypeIds = data.data.types
      .filter((t) => !visibleTypeIds.has(t.id))
      .map((t) => t.id);
    const excludedItemIds = data.data.types
      .flatMap((t) => t.checklistItems)
      .filter((i) => !visibleItemIds.has(i.id))
      .map((i) => i.id);
    saveMutation.mutate({ excludedTypeIds, excludedItemIds });
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <BackLink tenantId={id!} />

      <PageHeader
        title="Visibilità catalogo"
        description="Scegli quali tipi e voci sono visibili a questa officina."
        actions={
          <Button onClick={handleSave} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'Salvataggio...' : 'Salva'}
          </Button>
        }
      />

      {data.data.types.length === 0 ? (
        <EmptyState
          title="Nessun tipo attivo nel catalogo"
          description="Non ci sono tipi di intervento attivi da configurare per questa officina."
        />
      ) : (
        <div className="space-y-4">
          {data.data.types.map((type) => {
            const typeVisible = visibleTypeIds.has(type.id);
            return (
              <section
                key={type.id}
                aria-label={type.nameIt}
                className="rounded-md border p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{type.nameIt}</p>
                    <p className="text-sm text-muted-foreground">{type.code}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      id={`type-${type.id}`}
                      type="checkbox"
                      checked={typeVisible}
                      onChange={() => toggleType(type.id)}
                      // aria-label disambiguates this checkbox from the many
                      // other "Visibile" checkboxes on the page (one per
                      // type/item) — the visible <Label> text stays "Visibile"
                      // per the UI contract; this only refines the a11y name.
                      aria-label={`Visibile - ${type.nameIt}`}
                      className="h-4 w-4 rounded border-input"
                    />
                    <Label htmlFor={`type-${type.id}`}>Visibile</Label>
                  </div>
                </div>

                {type.checklistItems.length > 0 && (
                  <div className="ml-4 space-y-2 border-l pl-4">
                    {type.checklistItems.map((item) => (
                      <div
                        key={item.id}
                        role="group"
                        aria-label={item.nameIt}
                        // Note: this dim/disabled affordance is UI-only — the
                        // exclusion of the parent type still prevails at
                        // enforcement time (BR-305, applied in PR-4). The
                        // saved excludedItemIds set is always the complement
                        // of visibleItemIds regardless of typeVisible.
                        className={`flex items-center justify-between ${typeVisible ? '' : 'opacity-50'}`}
                      >
                        <p className="text-sm">{item.nameIt}</p>
                        <div className="flex items-center gap-2">
                          <input
                            id={`item-${item.id}`}
                            type="checkbox"
                            checked={visibleItemIds.has(item.id)}
                            disabled={!typeVisible}
                            onChange={() => toggleItem(item.id)}
                            aria-label={`Visibile - ${item.nameIt}`}
                            className="h-4 w-4 rounded border-input"
                          />
                          <Label htmlFor={`item-${item.id}`}>Visibile</Label>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
