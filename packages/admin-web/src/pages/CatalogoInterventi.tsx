// IT-strings — hardcoded, no i18n in this app.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { ClipboardList, Plus } from 'lucide-react';
import { useApiFetch, ApiError } from '@/lib/api-client';
import {
  CATALOG_ERROR_MESSAGES,
  GENERIC_CATALOG_ERROR,
  type InterventionTypeAdmin,
} from '@/lib/catalog-types';
import {
  catalogTypeSchema,
  editCatalogTypeSchema,
  type CatalogTypeValues,
  type CatalogTypeParsed,
  type EditCatalogTypeValues,
  type EditCatalogTypeParsed,
} from '@/lib/validators/catalog-type';
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

const CREATE_DEFAULTS: CatalogTypeValues = {
  code: '',
  nameIt: '',
  description: '',
  icon: '',
  suggestsDeadline: false,
  defaultDeadlineMonths: '',
  defaultDeadlineKm: '',
  active: true,
};

const EDIT_EMPTY: EditCatalogTypeValues = {
  nameIt: '',
  description: '',
  icon: '',
  suggestsDeadline: false,
  defaultDeadlineMonths: '',
  defaultDeadlineKm: '',
  active: true,
};

export function CatalogoInterventi() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Dialog state — null means closed.
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<InterventionTypeAdmin | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InterventionTypeAdmin | null>(null);

  const { data, isLoading, error } = useQuery<{ data: InterventionTypeAdmin[] }>({
    queryKey: ['admin-catalog-types'],
    queryFn: () => apiFetch('/v1/admin/intervention-types'),
  });

  const createForm = useForm<CatalogTypeValues, unknown, CatalogTypeParsed>({
    resolver: zodResolver(catalogTypeSchema),
    defaultValues: CREATE_DEFAULTS,
  });

  // `values` (not `defaultValues`) so the form repopulates whenever the row
  // being edited changes — mirrors the profile form in TenantDetail.tsx.
  const editForm = useForm<EditCatalogTypeValues, unknown, EditCatalogTypeParsed>({
    resolver: zodResolver(editCatalogTypeSchema),
    values: editTarget
      ? {
          nameIt: editTarget.nameIt,
          description: editTarget.description ?? '',
          icon: editTarget.icon ?? '',
          suggestsDeadline: editTarget.suggestsDeadline,
          defaultDeadlineMonths: editTarget.defaultDeadlineMonths?.toString() ?? '',
          defaultDeadlineKm: editTarget.defaultDeadlineKm?.toString() ?? '',
          active: editTarget.active,
        }
      : EDIT_EMPTY,
  });

  // ── Shared error handler (mirrors TenantList.tsx / TenantDetail.tsx) ─────────
  function handleMutationError(err: unknown) {
    if (err instanceof ApiError) {
      // api-client already fired toast.error('Sessione scaduta…') and signed the
      // user out for these codes — do not stack a second contradictory toast.
      if (err.code === 'auth.expired' || err.code === 'auth.no_token') return;
      toast.error(CATALOG_ERROR_MESSAGES[err.code] ?? GENERIC_CATALOG_ERROR);
    } else {
      toast.error(GENERIC_CATALOG_ERROR);
    }
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: (vals: CatalogTypeParsed) =>
      apiFetch<{ interventionType: InterventionTypeAdmin }>('/v1/admin/intervention-types', {
        method: 'POST',
        body: JSON.stringify(vals),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-catalog-types'] });
      toast.success('Tipo creato.');
      setCreateOpen(false);
      createForm.reset(CREATE_DEFAULTS);
    },
    onError: handleMutationError,
  });

  const editMutation = useMutation({
    mutationFn: (vals: EditCatalogTypeParsed) =>
      apiFetch<{ interventionType: InterventionTypeAdmin }>(
        `/v1/admin/intervention-types/${editTarget!.id}`,
        { method: 'PATCH', body: JSON.stringify(vals) },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-catalog-types'] });
      toast.success('Tipo aggiornato.');
      setEditTarget(null);
    },
    onError: handleMutationError,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      // api-client unconditionally sets Content-Type: application/json; Fastify
      // rejects an empty body with FST_ERR_CTP_EMPTY_JSON_BODY. Send '{}' to
      // satisfy the parser (same pattern as TenantList suspend/reactivate).
      // See [[feedback_fastify_empty_body_under_json_content_type]].
      apiFetch<void>(`/v1/admin/intervention-types/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-catalog-types'] });
      toast.success('Tipo eliminato.');
      setDeleteTarget(null);
    },
    onError: handleMutationError,
  });

  // ── Guards ────────────────────────────────────────────────────────────────────

  // Error check first — when the query fails, isLoading is false but data is
  // also undefined, so we must check error before the isLoading||!data guard.
  if (error) {
    return <ErrorState message="Errore nel caricamento del catalogo." />;
  }

  // Loading state — also guards against offline/paused state where data may be
  // undefined even though isLoading is false.
  // See [[feedback_react_query_data_bang_offline_paused]].
  if (isLoading || !data) {
    return <TableSkeleton columns={5} />;
  }

  function onCreateSubmit(vals: CatalogTypeParsed) {
    createMutation.mutate(vals);
  }

  function onEditSubmit(vals: EditCatalogTypeParsed) {
    editMutation.mutate(vals);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        description="Gestisci il catalogo globale dei tipi di intervento."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Nuovo tipo
          </Button>
        }
      />

      {data.data.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="Nessun tipo di intervento"
          description="Crea il primo tipo per iniziare a popolare il catalogo."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Codice</TableHead>
              <TableHead>Nome</TableHead>
              <TableHead>Voci</TableHead>
              <TableHead>Stato</TableHead>
              <TableHead>Azioni</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.data.map((type) => (
              <TableRow
                key={type.id}
                className="cursor-pointer"
                onClick={() => navigate(`/catalogo/${type.id}`)}
              >
                <TableCell className="font-medium">{type.code}</TableCell>
                <TableCell>{type.nameIt}</TableCell>
                <TableCell>{type.checklistItemCount}</TableCell>
                <TableCell>
                  <Badge variant={type.active ? 'default' : 'destructive'}>
                    {type.active ? 'Attivo' : 'Inattivo'}
                  </Badge>
                </TableCell>
                <TableCell>
                  {/* Stop propagation so row-level navigate() does not fire when
                      an action button inside the row is clicked. */}
                  <div className="flex gap-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
                    <Button variant="outline" size="sm" onClick={() => setEditTarget(type)}>
                      Modifica
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(type)}>
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
            <DialogTitle>Nuovo tipo di intervento</DialogTitle>
            <DialogDescription>Aggiungi un nuovo tipo al catalogo globale.</DialogDescription>
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
              <Label htmlFor="description">Descrizione</Label>
              <Input id="description" {...createForm.register('description')} />
              {createForm.formState.errors.description && (
                <p className="text-sm text-red-600">
                  {createForm.formState.errors.description.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="icon">Icona</Label>
              <Input id="icon" {...createForm.register('icon')} />
              {createForm.formState.errors.icon && (
                <p className="text-sm text-red-600">{createForm.formState.errors.icon.message}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                id="suggestsDeadline"
                type="checkbox"
                {...createForm.register('suggestsDeadline')}
                className="h-4 w-4 rounded border-input"
              />
              <Label htmlFor="suggestsDeadline">Suggerisce scadenza</Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="defaultDeadlineMonths">Mesi scadenza default</Label>
              <Input id="defaultDeadlineMonths" {...createForm.register('defaultDeadlineMonths')} />
              {createForm.formState.errors.defaultDeadlineMonths && (
                <p className="text-sm text-red-600">
                  {createForm.formState.errors.defaultDeadlineMonths.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="defaultDeadlineKm">Km scadenza default</Label>
              <Input id="defaultDeadlineKm" {...createForm.register('defaultDeadlineKm')} />
              {createForm.formState.errors.defaultDeadlineKm && (
                <p className="text-sm text-red-600">
                  {createForm.formState.errors.defaultDeadlineKm.message}
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
            <DialogTitle>Modifica tipo di intervento</DialogTitle>
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
              <Label htmlFor="edit-description">Descrizione</Label>
              <Input id="edit-description" {...editForm.register('description')} />
              {editForm.formState.errors.description && (
                <p className="text-sm text-red-600">
                  {editForm.formState.errors.description.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-icon">Icona</Label>
              <Input id="edit-icon" {...editForm.register('icon')} />
              {editForm.formState.errors.icon && (
                <p className="text-sm text-red-600">{editForm.formState.errors.icon.message}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                id="edit-suggestsDeadline"
                type="checkbox"
                {...editForm.register('suggestsDeadline')}
                className="h-4 w-4 rounded border-input"
              />
              <Label htmlFor="edit-suggestsDeadline">Suggerisce scadenza</Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-defaultDeadlineMonths">Mesi scadenza default</Label>
              <Input
                id="edit-defaultDeadlineMonths"
                {...editForm.register('defaultDeadlineMonths')}
              />
              {editForm.formState.errors.defaultDeadlineMonths && (
                <p className="text-sm text-red-600">
                  {editForm.formState.errors.defaultDeadlineMonths.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-defaultDeadlineKm">Km scadenza default</Label>
              <Input id="edit-defaultDeadlineKm" {...editForm.register('defaultDeadlineKm')} />
              {editForm.formState.errors.defaultDeadlineKm && (
                <p className="text-sm text-red-600">
                  {editForm.formState.errors.defaultDeadlineKm.message}
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
            <AlertDialogTitle>Elimina tipo di intervento</AlertDialogTitle>
            <AlertDialogDescription>
              Eliminare {deleteTarget?.nameIt}? L&apos;operazione non è reversibile. Se il tipo è in
              uso da uno o più interventi, disattivalo invece dalla modifica.
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
