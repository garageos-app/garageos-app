// IT-strings — hardcoded, no i18n in this app
import { Link, useLocation } from 'react-router-dom';
import { Home, Wrench, Users, Settings, LogOut, Plus } from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
import { Separator } from '@/components/ui/separator';

const navItems = [
  { id: 'home', label: 'Home', icon: Home, to: '/', enabled: true },
  { id: 'interventions', label: 'Interventi', icon: Wrench, to: '/interventions', enabled: true },
  { id: 'customers', label: 'Clienti', icon: Users, to: '/customers', enabled: true },
  { id: 'settings', label: 'Impostazioni', icon: Settings, to: '/settings', enabled: true },
] as const;

function isActiveFor(itemId: string, pathname: string): boolean {
  if (itemId === 'home') return pathname === '/';
  if (itemId === 'settings') return pathname.startsWith('/settings');
  if (itemId === 'customers') return pathname.startsWith('/customers');
  // Covers both the register (/interventions) and the detail (/interventions/:id).
  if (itemId === 'interventions') return pathname.startsWith('/interventions');
  return false;
}

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const { signOut } = useAuth();

  return (
    <div className="flex flex-col h-full p-4">
      <div className="font-bold text-lg tracking-tight mb-6 flex items-center gap-2">
        <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center">G</div>
        GarageOS
      </div>
      <Link
        to="/vehicles/new"
        onClick={() => onNavigate?.()}
        className="flex items-center justify-center gap-2 mb-4 px-3 py-2 rounded-md text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition"
      >
        <Plus size={16} />
        Nuovo veicolo
      </Link>
      <nav className="flex-1 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          if (item.enabled && 'to' in item) {
            const active = isActiveFor(item.id, pathname);
            return (
              <Link
                key={item.id}
                to={item.to}
                onClick={() => onNavigate?.()}
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
        onClick={() => {
          onNavigate?.();
          signOut();
        }}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-slate-300 hover:bg-slate-800 transition"
      >
        <LogOut size={16} />
        Esci
      </button>
    </div>
  );
}
