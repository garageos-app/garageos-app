import { ChevronDown, LogOut } from 'lucide-react';

import { useAuth } from '@/auth/useAuth';
import { getInitials } from '@/lib/initials';
import { useProfileMe } from '@/queries/profileMe';
import { ThemeToggle } from '@/theme/ThemeToggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// TopBar shows the brand strip + user menu (avatar / email + signOut).
// Avatar comes from useProfileMe (already cached by ProfileForm); when
// absent or loading, fallback to initials computed from the user's
// firstName / lastName. Email always shown next to avatar/initials.
export function TopBar() {
  const { state, signOut } = useAuth();
  const profileQuery = useProfileMe();

  const authedEmail = state.status === 'authenticated' ? state.user.email : '';
  const profile = profileQuery.data;
  const avatarUrl = profile?.avatarUrl ?? null;
  const initials = profile ? getInitials(profile.firstName, profile.lastName) : '?';

  return (
    <header className="bg-card border-b border-border px-6 py-3 flex items-center justify-between">
      <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
        Officina Bootstrap
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 text-sm text-foreground hover:opacity-80 transition">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                className="w-8 h-8 rounded-full object-cover bg-muted"
                data-testid="topbar-avatar-img"
              />
            ) : (
              <div
                className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold"
                data-testid="topbar-avatar-initials"
              >
                {initials}
              </div>
            )}
            <span>{authedEmail}</span>
            <ChevronDown size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={signOut}>
              <LogOut size={14} className="mr-2" /> Esci
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
