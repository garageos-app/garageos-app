import { SidebarNav } from './SidebarNav';

// Below lg the aside is hidden (display:none); at lg it becomes a flex-column
// grid child that stretches to full height, keeping SidebarNav's h-full inner
// div intact so "Esci" stays pinned to the bottom. This avoids the bug where
// wrapping <Sidebar /> in a hidden/block div collapses the aside to content height.
export function Sidebar() {
  return (
    <aside className="hidden lg:flex lg:flex-col w-[220px] bg-slate-900 dark:bg-slate-950 text-white border-r border-slate-800 dark:border-slate-900">
      <SidebarNav />
    </aside>
  );
}
