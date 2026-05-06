import { ChevronDown, LogOut } from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
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
    <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between">
      <div className="text-xs text-slate-500 font-medium uppercase tracking-wider">
        Officina Bootstrap
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center gap-2 text-sm text-slate-700 hover:text-slate-900 transition">
          <span>{email}</span>
          <ChevronDown size={14} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={signOut}>
            <LogOut size={14} className="mr-2" /> Esci
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
