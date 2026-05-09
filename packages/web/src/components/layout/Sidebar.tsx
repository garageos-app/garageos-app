// IT-strings — hardcoded, no i18n in demo-2
import { Link, useLocation } from 'react-router-dom';
import { Search, Wrench, Users, Settings, LogOut, Calendar } from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
import { Separator } from '@/components/ui/separator';

const navItems = [
  { id: 'search', label: 'Cerca veicolo', icon: Search, to: '/', enabled: true },
  { id: 'interventions', label: 'Interventi', icon: Wrench, enabled: false },
  { id: 'deadlines', label: 'Scadenze', icon: Calendar, to: '/deadlines', enabled: true },
  { id: 'customers', label: 'Clienti', icon: Users, enabled: false },
  { id: 'settings', label: 'Impostazioni', icon: Settings, enabled: false },
] as const;

function isActiveFor(itemId: string, pathname: string): boolean {
  if (itemId === 'search') {
    return pathname === '/' || pathname.startsWith('/search') || pathname.startsWith('/vehicles');
  }
  if (itemId === 'deadlines') {
    return pathname.startsWith('/deadlines');
  }
  return false;
}

export function Sidebar() {
  const { pathname } = useLocation();
  const { signOut } = useAuth();

  return (
    <aside className="w-[220px] bg-slate-900 dark:bg-slate-950 text-white flex flex-col p-4 border-r border-slate-800 dark:border-slate-900">
      <div className="font-bold text-lg tracking-tight mb-6 flex items-center gap-2">
        <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center">G</div>
        GarageOS
      </div>
      <nav className="flex-1 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          if (item.enabled && 'to' in item) {
            const active = isActiveFor(item.id, pathname);
            return (
              <Link
                key={item.id}
                to={item.to}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm transition ${
                  active ? 'bg-blue-900 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          }
          return (
            <div
              key={item.id}
              aria-disabled="true"
              title="Disponibile in v1.1"
              className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-slate-500 cursor-not-allowed"
            >
              <Icon size={16} />
              {item.label}
              <span className="ml-auto text-[10px] uppercase tracking-wide">soon</span>
            </div>
          );
        })}
      </nav>
      <Separator className="bg-slate-700 my-3" />
      <button
        type="button"
        onClick={signOut}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-slate-300 hover:bg-slate-800 transition"
      >
        <LogOut size={16} />
        Esci
      </button>
    </aside>
  );
}
