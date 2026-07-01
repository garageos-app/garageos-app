import { Outlet } from 'react-router-dom';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './AppSidebar';
import { Topbar } from './Topbar';

// shadcn's SidebarProvider persists the open/collapsed state to the
// `sidebar_state` cookie, but only reads it back during SSR. This is a
// client-only Vite SPA, so we read the cookie ourselves at mount and seed
// `defaultOpen` — otherwise the sidebar always reopens on reload.
function readSidebarOpenCookie(): boolean {
  const match = document.cookie.match(/(?:^|;\s*)sidebar_state=(true|false)/);
  // Default to open when the cookie is absent (first visit).
  return match ? match[1] === 'true' : true;
}

export function AppLayout() {
  return (
    <SidebarProvider defaultOpen={readSidebarOpenCookie()}>
      <AppSidebar />
      <SidebarInset>
        <Topbar />
        <div className="p-4 lg:p-6">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
