import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export function AppLayout() {
  return (
    <div className="min-h-screen grid grid-cols-[220px_1fr] bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-col min-h-screen">
        <TopBar />
        <main className="flex-1 bg-background">
          <div className="max-w-[1600px] mx-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
