import { ChevronDown, LogOut } from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
import { ThemeToggle } from '@/theme/ThemeToggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function TopBar() {
  const { state, signOut } = useAuth();
  const email = state.status === 'authenticated' ? state.user.email : '';

  return (
    <header className="bg-card border-b border-border px-6 py-3 flex items-center justify-between">
      <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
        Officina Bootstrap
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 text-sm text-foreground hover:opacity-80 transition">
            <span>{email}</span>
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
