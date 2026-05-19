import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useInvitations, useRevokeInvitation, useUsers } from '@/queries/users-admin';

import { InviteUserDialog } from '@/components/users/InviteUserDialog';
import { EditUserDialog } from '@/components/users/EditUserDialog';

export function UserManagement() {
  const usersQ = useUsers();
  const invsQ = useInvitations();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editingUser = (usersQ.data?.users ?? []).find((u) => u.id === editingId) ?? null;

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
                <Button variant="ghost" onClick={() => setEditingId(u.id)}>
                  Modifica
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <InviteUserDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      {editingUser && (
        <EditUserDialog
          user={editingUser}
          open={editingId !== null}
          onOpenChange={(o) => {
            if (!o) setEditingId(null);
          }}
        />
      )}
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
