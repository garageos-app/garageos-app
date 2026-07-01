// IT-strings — hardcoded, no i18n in this app.
import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Building2, ScrollText } from 'lucide-react';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, to: '/' },
  { id: 'officine', label: 'Officine', icon: Building2, to: '/officine' },
  { id: 'audit', label: 'Audit', icon: ScrollText, to: '/audit' },
] as const;

function isActiveFor(id: string, pathname: string): boolean {
  if (id === 'dashboard') return pathname === '/';
  if (id === 'officine') return pathname.startsWith('/officine');
  if (id === 'audit') return pathname.startsWith('/audit');
  return false;
}

export function NavMain() {
  const { pathname } = useLocation();
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActiveFor(item.id, pathname);
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                  <Link to={item.to} aria-current={active ? 'page' : undefined}>
                    <Icon />
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
