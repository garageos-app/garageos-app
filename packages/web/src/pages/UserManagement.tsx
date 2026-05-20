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
  const [showInactive, setShowInactive] = useState(false);

  const allUsers = usersQ.data?.users ?? [];
  const editingUser = allUsers.find((u) => u.id === editingId) ?? null;
  const visibleUsers = showInactive ? allUsers : allUsers.filter((u) => u.status === 'active');
  const inactiveCount = allUsers.filter((u) => u.status === 'inactive').length;

  if (usersQ.isLoading || invsQ.isLoading) return <div>Caricamento...</div>;
  if (usersQ.isError) return <div>Errore caricamento utenti.</div>;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Utenti</h2>
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
        <div className="flex justify-between items-center mb-2">
          <h3 className="font-medium">{showInactive ? 'Tutti gli utenti' : 'Utenti attivi'}</h3>
          {inactiveCount > 0 && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                data-testid="toggle-show-inactive"
              />
              Mostra utenti disattivati ({inactiveCount})
            </label>
          )}
        </div>
        {!visibleUsers.length ? (
          <p className="text-muted-foreground">Nessun utente.</p>
        ) : (
          <ul className="divide-y border rounded">
            {visibleUsers.map((u) => (
              <li
                key={u.id}
                className={`p-3 flex justify-between items-center ${u.status === 'inactive' ? 'opacity-60' : ''}`}
                data-testid={`user-row-${u.id}`}
              >
                <div>
                  <div className="font-medium">
                    {u.firstName} {u.lastName}
                    {u.status === 'inactive' && (
                      <span className="ml-2 inline-block text-xs font-normal text-muted-foreground border border-muted-foreground/30 rounded px-1.5 py-0.5">
                        Disattivato
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {u.email} — {u.role}
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
