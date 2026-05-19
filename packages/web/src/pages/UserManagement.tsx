import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useInvitations, useRevokeInvitation, useUsers } from '@/queries/users-admin';

// TODO (T15): import InviteUserDialog from '@/components/users/InviteUserDialog'
// TODO (T16): import EditUserDialog from '@/components/users/EditUserDialog'

export function UserManagement() {
  const usersQ = useUsers();
  const invsQ = useInvitations();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Suppress unused-state warnings until T15/T16 wire up the dialogs
  void inviteOpen;
  void editingId;

  if (usersQ.isLoading || invsQ.isLoading) return <div>Caricamento...</div>;
  if (usersQ.isError) return <div>Errore caricamento utenti.</div>;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Utenti</h2>
        {/* TODO (T15): open InviteUserDialog on click */}
        <Button onClick={() => setInviteOpen(true)}>Invita utente</Button>
      </div>

      <section>
        <h3 className="font-medium mb-2">Inviti pendenti</h3>
        {invsQ.isError || !invsQ.data?.invitations.length ? (
          <p className="text-muted-foreground">Nessun invito pendente.</p>
        ) : (
          <ul className="divide-y border rounded">
            {invsQ.data.invitations.map((inv) => (
              <li key={inv.id} className="p-3 flex justify-between items-center">
                <div>
                  <div className="font-medium">
                    {inv.firstName} {inv.lastName}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {inv.targetEmail} — {inv.role}
                  </div>
                </div>
                <RevokeInviteButton id={inv.id} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="font-medium mb-2">Utenti attivi</h3>
        {!usersQ.data?.users.length ? (
          <p className="text-muted-foreground">Nessun utente.</p>
        ) : (
          <ul className="divide-y border rounded">
            {usersQ.data.users.map((u) => (
              <li key={u.id} className="p-3 flex justify-between items-center">
                <div>
                  <div className="font-medium">
                    {u.firstName} {u.lastName}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {u.email} — {u.role} — {u.status}
                  </div>
                </div>
                {/* TODO (T16): open EditUserDialog */}
                <Button variant="ghost" onClick={() => setEditingId(u.id)}>
                  Modifica
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* TODO (T15): <InviteUserDialog open={inviteOpen} onOpenChange={setInviteOpen} /> */}
      {/* TODO (T16): {editingId && <EditUserDialog userId={editingId} open onOpenChange={(o) => !o && setEditingId(null)} />} */}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function RevokeInviteButton({ id }: { id: string }) {
  const mut = useRevokeInvitation();
  return (
    <Button
      variant="ghost"
      disabled={mut.isPending}
      onClick={() => {
        mut.mutate(id);
      }}
    >
      Revoca
    </Button>
  );
}
