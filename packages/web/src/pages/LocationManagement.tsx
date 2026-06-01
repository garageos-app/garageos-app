import { useState } from 'react';

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
import { Button } from '@/components/ui/button';
import { LocationFormDialog } from '@/components/locations/LocationFormDialog';
import {
  useLocations,
  useUpdateLocation,
  useDeleteLocation,
  type TenantLocation,
} from '@/queries/locations';

export function LocationManagement() {
  const locationsQ = useLocations();
  const updateMut = useUpdateLocation();
  const deleteMut = useDeleteLocation();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TenantLocation | null>(null);
  const [toDeactivate, setToDeactivate] = useState<TenantLocation | null>(null);

  if (locationsQ.isPending) return <div>Caricamento...</div>;
  if (locationsQ.isError) return <div className="text-red-600">Errore caricamento sedi.</div>;

  const locations = locationsQ.data?.locations ?? [];

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }
  function openEdit(loc: TenantLocation) {
    setEditing(loc);
    setFormOpen(true);
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Sedi</h2>
        <Button onClick={openCreate}>Aggiungi sede</Button>
      </div>

      {!locations.length ? (
        <p className="text-muted-foreground">Nessuna sede.</p>
      ) : (
        <ul className="divide-y border rounded">
          {locations.map((loc) => (
            <li
              key={loc.id}
              className="p-3 flex justify-between items-center"
              data-testid={`location-row-${loc.id}`}
            >
              <div>
                <div className="font-medium">
                  {loc.name}
                  {loc.isPrimary && (
                    <span className="ml-2 inline-block text-xs font-normal text-muted-foreground border border-muted-foreground/30 rounded px-1.5 py-0.5">
                      Primaria
                    </span>
                  )}
                </div>
                <div className="text-sm text-muted-foreground">
                  {loc.addressLine}, {loc.postalCode} {loc.city} ({loc.province})
                </div>
              </div>
              <div className="flex gap-2">
                {!loc.isPrimary && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={updateMut.isPending}
                    onClick={() => updateMut.mutate({ id: loc.id, body: { isPrimary: true } })}
                    data-testid={`set-primary-${loc.id}`}
                  >
                    Imposta primaria
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => openEdit(loc)}>
                  Modifica
                </Button>
                {!loc.isPrimary && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setToDeactivate(loc)}
                    data-testid={`deactivate-${loc.id}`}
                  >
                    Disattiva
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <LocationFormDialog
        location={editing}
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o);
          if (!o) setEditing(null);
        }}
      />

      <AlertDialog
        open={toDeactivate !== null}
        onOpenChange={(o) => {
          if (!o) setToDeactivate(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disattivare la sede?</AlertDialogTitle>
            <AlertDialogDescription>
              {toDeactivate?.name} verrà disattivata. Gli interventi storici restano consultabili.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (toDeactivate) deleteMut.mutate(toDeactivate.id);
                setToDeactivate(null);
              }}
            >
              Disattiva
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
