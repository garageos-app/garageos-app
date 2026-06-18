import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Search } from 'lucide-react';

import { useAuth } from '@/auth/useAuth';
import { LocationSelector } from '@/location-filter/LocationSelector';
import { getInitials } from '@/lib/initials';
import { useProfileMe } from '@/queries/profileMe';
import { ThemeToggle } from '@/theme/ThemeToggle';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// TopBar shows the brand strip + global search input + user menu (avatar /
// email + signOut). Avatar comes from useProfileMe (already cached by
// ProfileForm); when absent or loading, fallback to initials.
// Global search (F-OFF-502): on submit, any input of >= 2 chars routes to
// `/search?q=<raw>`. Classification (vehicle identifier vs customer
// name/phone) happens in SearchResults, which runs both a vehicle search
// (when q looks like a VIN / plate / garage_code) and a customer search
// (name / phone) and renders the matching sections. A 1-char input shows
// an inline hint and does NOT navigate (mirrors the backend q >= 2 minimum).
export function TopBar() {
  const { state, signOut } = useAuth();
  const profileQuery = useProfileMe();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const authedEmail = state.status === 'authenticated' ? state.user.email : '';
  const profile = profileQuery.data;
  const avatarUrl = profile?.avatarUrl ?? null;
  const initials = profile ? getInitials(profile.firstName, profile.lastName) : '?';
  // Brand strip: officina business name + the user's assigned sede.
  // Falls back to a neutral label until the profile query resolves.
  const officinaName = profile ? `Officina ${profile.tenant.businessName}` : 'GarageOS';
  const sedeName = profile?.location?.name ?? null;

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    if (trimmed.length < 2) {
      setError('Inserisci almeno 2 caratteri.');
      return;
    }
    setError(null);
    navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <header className="bg-card border-b border-border px-6 py-3 flex items-center gap-4">
      <div className="text-xs font-medium uppercase tracking-wider shrink-0">
        <span className="text-foreground">{officinaName}</span>
        {sedeName && <span className="text-muted-foreground"> · {sedeName}</span>}
      </div>
      <form onSubmit={onSearchSubmit} className="flex-1 max-w-xl mx-auto" role="search">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Cerca veicolo o cliente…"
            className="pl-9 h-9"
            aria-label="Cerca"
            aria-invalid={error !== null}
          />
          {error && (
            <div
              role="alert"
              className="absolute left-0 right-0 top-full mt-1 text-xs text-destructive bg-card border border-destructive/40 rounded px-2 py-1 shadow-sm"
            >
              {error}
            </div>
          )}
        </div>
      </form>
      <div className="flex items-center gap-2">
        <LocationSelector />
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
