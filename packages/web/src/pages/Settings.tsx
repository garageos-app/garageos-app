import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { UseFormReturn } from 'react-hook-form';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PasswordForm } from '@/components/settings/PasswordForm';
import { ProfileForm } from '@/components/settings/ProfileForm';
import { TenantForm } from '@/components/settings/TenantForm';
import { UserManagement } from '@/pages/UserManagement';
import { LocationManagement } from '@/pages/LocationManagement';
import { useAuth } from '@/auth/useAuth';
import { useProfileMe } from '@/queries/profileMe';
import { useTenantMe } from '@/queries/tenantMe';
import type { ChangePasswordFormValues } from '@/lib/validators/password';
import type { ProfileFormValues, ProfileFormParsed } from '@/lib/validators/profile';
import type { TenantFormValues, TenantFormParsed } from '@/lib/validators/tenant';

type TabId = 'profile' | 'security' | 'tenant' | 'users' | 'locations';

function pathnameToTab(pathname: string): TabId {
  if (pathname === '/settings/users') return 'users';
  if (pathname === '/settings/locations') return 'locations';
  return 'profile';
}

export function Settings() {
  const { state } = useAuth();
  // AuthContext shape: state is discriminated by `status`, not `kind`.
  // When authenticated, state.user.role is UserRole | undefined.
  const role = state.status === 'authenticated' ? state.user.role : undefined;
  const isSuperAdmin = role === 'super_admin';

  const location = useLocation();
  const navigate = useNavigate();
  const profileQuery = useProfileMe();
  const tenantQuery = useTenantMe({ enabled: isSuperAdmin });

  // Derive the active tab from the URL so that /settings/users opens the Utenti tab.
  const [activeTab, setActiveTab] = useState<TabId>(() => pathnameToTab(location.pathname));
  const [pendingTab, setPendingTab] = useState<TabId | null>(null);
  const profileFormRef = useRef<UseFormReturn<
    ProfileFormValues,
    unknown,
    ProfileFormParsed
  > | null>(null);
  const passwordFormRef = useRef<UseFormReturn<ChangePasswordFormValues> | null>(null);
  const tenantFormRef = useRef<UseFormReturn<TenantFormValues, unknown, TenantFormParsed> | null>(
    null,
  );

  function anyDirty(): boolean {
    return (
      profileFormRef.current?.formState.isDirty === true ||
      passwordFormRef.current?.formState.isDirty === true ||
      tenantFormRef.current?.formState.isDirty === true
    );
  }

  function tabToPath(tab: TabId): string {
    if (tab === 'users') return '/settings/users';
    if (tab === 'locations') return '/settings/locations';
    return '/settings';
  }

  function handleTabChange(next: string) {
    const nextTab = next as TabId;
    if (nextTab === activeTab) return;
    if (anyDirty()) {
      setPendingTab(nextTab);
    } else {
      setActiveTab(nextTab);
      navigate(tabToPath(nextTab), { replace: true });
    }
  }

  function discardChangesAndSwitch() {
    if (!pendingTab) return;
    profileFormRef.current?.reset();
    passwordFormRef.current?.reset();
    tenantFormRef.current?.reset();
    setActiveTab(pendingTab);
    navigate(tabToPath(pendingTab), { replace: true });
    setPendingTab(null);
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">Impostazioni</h1>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="profile">Profilo</TabsTrigger>
          <TabsTrigger value="security">Sicurezza</TabsTrigger>
          {isSuperAdmin && <TabsTrigger value="tenant">Officina</TabsTrigger>}
          {isSuperAdmin && <TabsTrigger value="users">Utenti</TabsTrigger>}
          {isSuperAdmin && <TabsTrigger value="locations">Sedi</TabsTrigger>}
        </TabsList>

        <TabsContent value="profile" className="mt-6">
          {profileQuery.isPending && <p>Caricamento...</p>}
          {profileQuery.isError && <p className="text-red-600">Errore nel caricare il profilo.</p>}
          {profileQuery.data && (
            <ProfileForm
              profile={profileQuery.data}
              formRef={(f) => {
                profileFormRef.current = f;
              }}
            />
          )}
        </TabsContent>

        <TabsContent value="security" className="mt-6">
          <PasswordForm
            formRef={(f) => {
              passwordFormRef.current = f;
            }}
          />
        </TabsContent>

        {isSuperAdmin && (
          <TabsContent value="tenant" className="mt-6">
            {tenantQuery.isPending && <p>Caricamento...</p>}
            {tenantQuery.isError && (
              <p className="text-red-600">Errore nel caricare i dati officina.</p>
            )}
            {tenantQuery.data && (
              <TenantForm
                tenant={tenantQuery.data}
                formRef={(f) => {
                  tenantFormRef.current = f;
                }}
              />
            )}
          </TabsContent>
        )}

        {isSuperAdmin && (
          <TabsContent value="users" className="mt-6">
            <UserManagement />
          </TabsContent>
        )}

        {isSuperAdmin && (
          <TabsContent value="locations" className="mt-6">
            <LocationManagement />
          </TabsContent>
        )}
      </Tabs>

      <AlertDialog
        open={pendingTab !== null}
        onOpenChange={(open) => {
          if (!open) setPendingTab(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Modifiche non salvate</AlertDialogTitle>
            <AlertDialogDescription>
              Hai modifiche non salvate in questo modulo. Vuoi continuare e scartarle?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction onClick={discardChangesAndSwitch}>
              Continua senza salvare
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
