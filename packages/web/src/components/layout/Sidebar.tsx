import { SidebarNav } from './SidebarNav';

export function Sidebar() {
  return (
    <aside className="w-[220px] bg-slate-900 dark:bg-slate-950 text-white border-r border-slate-800 dark:border-slate-900">
      <SidebarNav />
    </aside>
  );
}
