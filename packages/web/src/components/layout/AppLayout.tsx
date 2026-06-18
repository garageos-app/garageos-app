import { useState } from 'react';
import { Outlet } from 'react-router-dom';

import { LocationFilterProvider } from '@/location-filter/LocationFilterContext';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

import { Sidebar } from './Sidebar';
import { SidebarNav } from './SidebarNav';
import { TopBar } from './TopBar';

export function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <LocationFilterProvider>
      <div className="min-h-screen lg:grid lg:grid-cols-[220px_1fr] bg-background text-foreground">
        {/* Desktop sidebar — hidden below lg via aside className, replaced by the drawer */}
        <Sidebar />

        {/* Mobile drawer — same nav content, closes on navigation */}
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent data-testid="mobile-drawer">
            <SheetTitle className="sr-only">Menu di navigazione</SheetTitle>
            <SidebarNav onNavigate={() => setNavOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex flex-col min-h-screen min-w-0">
          <TopBar onMenuClick={() => setNavOpen(true)} />
          <main className="flex-1 bg-background min-w-0">
            <div className="max-w-[1600px] mx-auto">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </LocationFilterProvider>
  );
}
