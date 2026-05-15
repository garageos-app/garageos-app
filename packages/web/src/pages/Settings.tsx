import { useRef, useState } from 'react';
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
import { ProfileForm } from '@/components/settings/ProfileForm';
import { TenantForm } from '@/components/settings/TenantForm';
import { useAuth } from '@/auth/useAuth';
import { useProfileMe } from '@/queries/profileMe';
import { useTenantMe } from '@/queries/tenantMe';
import type { ProfileFormValues, ProfileFormParsed } from '@/lib/validators/profile';
import type { TenantFormValues, TenantFormParsed } from '@/lib/validators/tenant';

type TabId = 'profile' | 'tenant';

export function Settings() {
  const { state } = useAuth();
  // AuthContext shape: state is discriminated by `status`, not `kind`.
  // When authenticated, state.user.role is UserRole | undefined.
  const role = state.status === 'authenticated' ? state.user.role : undefined;
  const isSuperAdmin = role === 'super_admin';

  const profileQuery = useProfileMe();
  const tenantQuery = useTenantMe({ enabled: isSuperAdmin });

  const [activeTab, setActiveTab] = useState<TabId>('profile');
  const [pendingTab, setPendingTab] = useState<TabId | null>(null);
  const profileFormRef = useRef<UseFormReturn<
    ProfileFormValues,
    unknown,
    ProfileFormParsed
  > | null>(null);
  const tenantFormRef = useRef<UseFormReturn<TenantFormValues, unknown, TenantFormParsed> | null>(
    null,
  );

  function anyDirty(): boolean {
    return (
      profileFormRef.current?.formState.isDirty === true ||
      tenantFormRef.current?.formState.isDirty === true
    );
  }

  function handleTabChange(next: string) {
    const nextTab = next as TabId;
    if (nextTab === activeTab) return;
    if (anyDirty()) {
      setPendingTab(nextTab);
    } else {
      setActiveTab(nextTab);
    }
  }

  function discardChangesAndSwitch() {
    if (!pendingTab) return;
    profileFormRef.current?.reset();
    tenantFormRef.current?.reset();
    setActiveTab(pendingTab);
    setPendingTab(null);
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">Impostazioni</h1>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="profile">Profilo</TabsTrigger>
          {isSuperAdmin && <TabsTrigger value="tenant">Officina</TabsTrigger>}
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
