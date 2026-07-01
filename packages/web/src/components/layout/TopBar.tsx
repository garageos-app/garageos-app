import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Menu, Search, X } from 'lucide-react';

import { useAuth } from '@/auth/useAuth';
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

// TopBar shows the brand strip + global search input + user menu (initials
// avatar + email + signOut). Initials come from useProfileMe (already
// cached by ProfileForm); render '?' while the profile query is loading.
// Global search (F-OFF-502): on submit, any input of >= 2 chars routes to
// `/search?q=<raw>`. Classification (vehicle identifier vs customer
// name/phone) happens in SearchResults, which runs both a vehicle search
// (when q looks like a VIN / plate / garage_code) and a customer search
// (name / phone) and renders the matching sections. A 1-char input shows
// an inline hint and does NOT navigate (mirrors the backend q >= 2 minimum).
// onMenuClick is required — AppLayout always supplies it.
export function TopBar({ onMenuClick }: { onMenuClick: () => void }) {
  const { state, signOut } = useAuth();
  const profileQuery = useProfileMe();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  const authedEmail = state.status === 'authenticated' ? state.user.email : '';
  const profile = profileQuery.data;
  const initials = profile ? getInitials(profile.firstName, profile.lastName) : '?';
  // Brand strip: officina business name.
  // Falls back to a neutral label until the profile query resolves.
  const officinaName = profile ? `Officina ${profile.tenant.businessName}` : 'GarageOS';

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    if (trimmed.length < 2) {
      setError('Inserisci almeno 2 caratteri.');
      return;
    }
    setError(null);
    setMobileSearchOpen(false);
    navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <header className="relative bg-card border-b border-border px-4 lg:px-6 py-3 flex items-center gap-3 lg:gap-4">
      {/* Hamburger — mobile/tablet only */}
      <button
        type="button"
        onClick={onMenuClick}
        className="lg:hidden shrink-0 text-foreground hover:opacity-80 transition"
        aria-label="Apri menu"
      >
        <Menu size={20} />
      </button>

      {/* Brand — hidden on the narrowest screens to save room */}
      <div className="hidden sm:block text-xs font-medium uppercase tracking-wider shrink-0 truncate max-w-[40vw]">
        <span className="text-foreground">{officinaName}</span>
      </div>

      {/* Desktop inline search */}
      <form
        onSubmit={submitSearch}
        className="hidden lg:block flex-1 max-w-xl mx-auto"
        role="search"
      >
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

      {/* Spacer pushes the right cluster to the edge below lg */}
      <div className="flex-1 lg:hidden" />

      <div className="flex items-center gap-2 shrink-0">
        {/* Mobile search trigger */}
        <button
          type="button"
          onClick={() => setMobileSearchOpen(true)}
          className="lg:hidden text-foreground hover:opacity-80 transition"
          aria-label="Cerca"
        >
          <Search size={18} />
        </button>
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 text-sm text-foreground hover:opacity-80 transition">
            <div
              className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold"
              data-testid="topbar-avatar-initials"
            >
              {initials}
            </div>
            {/* Email is noise on mobile — desktop only */}
            <span className="hidden lg:inline">{authedEmail}</span>
            <ChevronDown size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={signOut}>
              <LogOut size={14} className="mr-2" /> Esci
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Mobile search overlay row — covers the header when open */}
      {mobileSearchOpen && (
        <form
          onSubmit={submitSearch}
          role="search"
          className="absolute inset-0 z-10 flex items-center gap-2 bg-card px-4"
        >
          <div className="relative flex-1">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            <Input
              type="search"
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setMobileSearchOpen(false);
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
          <button
            type="button"
            onClick={() => setMobileSearchOpen(false)}
            className="shrink-0 text-foreground hover:opacity-80 transition"
            aria-label="Chiudi ricerca"
          >
            <X size={18} />
          </button>
        </form>
      )}
    </header>
  );
}
