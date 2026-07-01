// IT-strings — hardcoded, no i18n in this app.
import { useLocation } from 'react-router-dom';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/theme/ThemeToggle';

export function titleForPath(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  if (pathname.startsWith('/officine/nuova')) return 'Crea officina';
  if (/^\/officine\/[^/]+$/.test(pathname)) return 'Dettaglio officina';
  if (pathname.startsWith('/officine')) return 'Officine';
  if (pathname.startsWith('/audit')) return 'Audit';
  return 'Console piattaforma';
}

export function Topbar() {
  const { pathname } = useLocation();
  const title = titleForPath(pathname);
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <h1 className="text-base font-semibold">{title}</h1>
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  );
}
