// IT-strings — hardcoded, no i18n in this app.
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { ListChecks, Plus } from 'lucide-react';
import { useApiFetch, ApiError } from '@/lib/api-client';
import {
  CATALOG_ERROR_MESSAGES,
  CHECKLIST_ITEM_ERROR_MESSAGES,
  GENERIC_CATALOG_ERROR,
  type InterventionTypeAdmin,
  type ChecklistItemAdmin,
} from '@/lib/catalog-types';
import {
  catalogItemSchema,
  editCatalogItemSchema,
  type CatalogItemValues,
  type CatalogItemParsed,
  type EditCatalogItemValues,
  type EditCatalogItemParsed,
} from '@/lib/validators/catalog-item';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { TableSkeleton } from '@/components/feedback/TableSkeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const CREATE_DEFAULTS: CatalogItemValues = {
  code: '',
  nameIt: '',
  sortOrder: '0',
  active: true,
};

const EDIT_EMPTY: EditCatalogItemValues = {
  nameIt: '',
  sortOrder: '0',
  active: true,
};

// Back link + title/description shared by every early-return branch below —
// mirrors the back-link wrapper pattern in TenantDetail.tsx.
function BackLink() {
  return (
    <Link to="/catalogo" className="text-sm text-muted-foreground hover:underline inline-block">
      ← Catalogo
    </Link>
  );
}

export function CatalogoInterventoDetail() {
  // id is always defined when this component is mounted via <Route path="/catalogo/:id" />.
  const { id } = useParams<{ id: string }>();
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();

  // Dialog state — null means closed.
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ChecklistItemAdmin | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChecklistItemAdmin | null>(null);

  // Types list — shares Task 3's cache key so navigating from /catalogo is
  // instant; refetches if the cache is cold (e.g. deep link/page refresh).
  const {
    data: typesData,
    isLoading: typesLoading,
    error: typesError,
  } = useQuery<{ data: InterventionTypeAdmin[] }>({
    queryKey: ['admin-catalog-types'],
    queryFn: () => apiFetch('/v1/admin/intervention-types'),
  });

  // Checklist items for this type — independent query/cache key, keyed by id.
  const {
    data: itemsData,
    isLoading: itemsLoading,
    error: itemsError,
  } = useQuery<{ data: ChecklistItemAdmin[] }>({
    queryKey: ['admin-catalog-items', id],
    queryFn: () => apiFetch(`/v1/admin/intervention-types/${id}/checklist-items`),
    enabled: !!id,
  });

  const createForm = useForm<CatalogItemValues, unknown, CatalogItemParsed>({
    resolver: zodResolver(catalogItemSchema),
    defaultValues: CREATE_DEFAULTS,
  });

  // `values` (not `defaultValues`) so the form repopulates whenever the row
  // being edited changes — mirrors CatalogoInterventi.tsx's editForm.
  const editForm = useForm<EditCatalogItemValues, unknown, EditCatalogItemParsed>({
    resolver: zodResolver(editCatalogItemSchema),
    values: editTarget
      ? {
          nameIt: editTarget.nameIt,
          sortOrder: editTarget.sortOrder.toString(),
          active: editTarget.active,
        }
      : EDIT_EMPTY,
  });

  // ── Shared error handler (mirrors CatalogoInterventi.tsx) ────────────────────
  // Looks up both error maps: the nested checklist-item routes can also
  // surface the parent type's admin.intervention_type.not_found (e.g. the
  // type was deleted concurrently in another tab).
  function handleMutationError(err: unknown) {
    if (err instanceof ApiError) {
      // api-client already fired toast.error('Sessione scaduta…') and signed the
      // user out for these codes — do not stack a second contradictory toast.
      if (err.code === 'auth.expired' || err.code === 'auth.no_token') return;
      toast.error(
        CHECKLIST_ITEM_ERROR_MESSAGES[err.code] ??
          CATALOG_ERROR_MESSAGES[err.code] ??
          GENERIC_CATALOG_ERROR,
      );
    } else {
      toast.error(GENERIC_CATALOG_ERROR);
    }
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: (vals: CatalogItemParsed) =>
      apiFetch<{ checklistItem: ChecklistItemAdmin }>(
        `/v1/admin/intervention-types/${id}/checklist-items`,
        { method: 'POST', body: JSON.stringify(vals) },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-catalog-items', id] });
      toast.success('Voce creata.');
      setCreateOpen(false);
      createForm.reset(CREATE_DEFAULTS);
    },
    onError: handleMutationError,
  });

  const editMutation = useMutation({
    mutationFn: (vals: EditCatalogItemParsed) =>
      apiFetch<{ checklistItem: ChecklistItemAdmin }>(
        `/v1/admin/checklist-items/${editTarget!.id}`,
        { method: 'PATCH', body: JSON.stringify(vals) },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-catalog-items', id] });
      toast.success('Voce aggiornata.');
      setEditTarget(null);
    },
    onError: handleMutationError,
  });

  const deleteMutation = useMutation({
    mutationFn: (itemId: string) =>
      apiFetch<void>(`/v1/admin/checklist-items/${itemId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-catalog-items', id] });
      toast.success('Voce eliminata.');
      setDeleteTarget(null);
    },
    onError: handleMutationError,
  });

  // ── Guards ────────────────────────────────────────────────────────────────────

  // Error check first — when the query fails, isLoading is false but data is
  // also undefined, so we must check error before the isLoading||!data guard.
  if (typesError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState message="Errore nel caricamento del catalogo." />
      </div>
    );
  }

  // Loading state — also guards against offline/paused state where data may be
  // undefined even though isLoading is false.
  // See [[feedback_react_query_data_bang_offline_paused]].
  if (typesLoading || !typesData) {
    return (
      <div className="space-y-4">
        <BackLink />
        <TableSkeleton columns={5} />
      </div>
    );
  }

  const type = typesData.data.find((t) => t.id === id);
  if (!type) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState message="Tipo non trovato." />
      </div>
    );
  }

  if (itemsError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <PageHeader title={`${type.nameIt} (${type.code})`} />
        <ErrorState message="Errore nel caricamento delle voci." />
      </div>
    );
  }

  if (itemsLoading || !itemsData) {
    return (
      <div className="space-y-4">
        <BackLink />
        <PageHeader title={`${type.nameIt} (${type.code})`} />
        <TableSkeleton columns={5} />
      </div>
    );
  }

  function onCreateSubmit(vals: CatalogItemParsed) {
    createMutation.mutate(vals);
  }

  function onEditSubmit(vals: EditCatalogItemParsed) {
    editMutation.mutate(vals);
  }

  return (
    <div className="space-y-6">
      <BackLink />

      <PageHeader
        title={`${type.nameIt} (${type.code})`}
        description="Gestisci le voci checklist per questo tipo di intervento."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Nuova voce
          </Button>
        }
      />

      {itemsData.data.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="Nessuna voce checklist"
          description="Crea la prima voce per questo tipo di intervento."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Codice</TableHead>
              <TableHead>Nome</TableHead>
              <TableHead>Ordine</TableHead>
              <TableHead>Stato</TableHead>
              <TableHead>Azioni</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {itemsData.data.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-medium">{item.code}</TableCell>
                <TableCell>{item.nameIt}</TableCell>
                <TableCell>{item.sortOrder}</TableCell>
                <TableCell>
                  <Badge variant={item.active ? 'default' : 'destructive'}>
                    {item.active ? 'Attivo' : 'Inattivo'}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex gap-2 flex-wrap">
                    <Button variant="outline" size="sm" onClick={() => setEditTarget(item)}>
                      Modifica
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(item)}>
                      Elimina
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* ── Create dialog ─────────────────────────────────────────────────────── */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            createForm.reset(CREATE_DEFAULTS);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nuova voce checklist</DialogTitle>
            <DialogDescription>Aggiungi una nuova voce a questo tipo.</DialogDescription>
          </DialogHeader>
          <form onSubmit={createForm.handleSubmit(onCreateSubmit)} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="code">Codice</Label>
              <Input id="code" {...createForm.register('code')} />
              {createForm.formState.errors.code && (
                <p className="text-sm text-red-600">{createForm.formState.errors.code.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="nameIt">Nome</Label>
              <Input id="nameIt" {...createForm.register('nameIt')} />
              {createForm.formState.errors.nameIt && (
                <p className="text-sm text-red-600">{createForm.formState.errors.nameIt.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="sortOrder">Ordine</Label>
              <Input id="sortOrder" {...createForm.register('sortOrder')} />
              {createForm.formState.errors.sortOrder && (
                <p className="text-sm text-red-600">
                  {createForm.formState.errors.sortOrder.message}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                id="active"
                type="checkbox"
                {...createForm.register('active')}
                className="h-4 w-4 rounded border-input"
              />
              <Label htmlFor="active">Attivo</Label>
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCreateOpen(false);
                  createForm.reset(CREATE_DEFAULTS);
                }}
              >
                Annulla
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Creazione...' : 'Crea'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Edit dialog ────────────────────────────────────────────────────────── */}
      <Dialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modifica voce checklist</DialogTitle>
            <DialogDescription>
              {editTarget?.code} — il codice non è modificabile.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="edit-nameIt">Nome</Label>
              <Input id="edit-nameIt" {...editForm.register('nameIt')} />
              {editForm.formState.errors.nameIt && (
                <p className="text-sm text-red-600">{editForm.formState.errors.nameIt.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-sortOrder">Ordine</Label>
              <Input id="edit-sortOrder" {...editForm.register('sortOrder')} />
              {editForm.formState.errors.sortOrder && (
                <p className="text-sm text-red-600">
                  {editForm.formState.errors.sortOrder.message}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                id="edit-active"
                type="checkbox"
                {...editForm.register('active')}
                className="h-4 w-4 rounded border-input"
              />
              <Label htmlFor="edit-active">Attivo</Label>
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={() => setEditTarget(null)}>
                Annulla
              </Button>
              <Button type="submit" disabled={editMutation.isPending}>
                {editMutation.isPending ? 'Salvataggio...' : 'Salva'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm dialog ──────────────────────────────────────────────── */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Elimina voce checklist</AlertDialogTitle>
            <AlertDialogDescription>
              Eliminare {deleteTarget?.nameIt}? L&apos;operazione non è reversibile. Le selezioni
              storiche restano intatte (l&apos;etichetta è già salvata separatamente).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Annulla</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                // Prevent the AlertDialog from closing before the mutation resolves;
                // onSuccess closes it explicitly via setDeleteTarget(null).
                e.preventDefault();
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
              }}
            >
              Elimina
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
