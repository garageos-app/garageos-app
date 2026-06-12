// Routes push-notification taps to the screen the payload points at. Mounted
// once in the root layout (inside AuthProvider). Covers both taps while the
// app runs (response listener) and taps that launched the app from the killed
// state (getLastNotificationResponseAsync). Navigation is gated on auth: while
// the session is still loading the target stays pending; an unauthenticated
// tap is dropped (the normal flow lands on login — no defer-through-login).
import { useEffect, useState } from 'react';
import { useRouter, useRootNavigationState, type Href } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useAuth } from '@/auth/useAuth';
import { resolveNotificationTarget } from '@/lib/notification-routing';

// Module scope, not a ref: the same tap can surface through both the
// cold-start read and the listener, and getLastNotificationResponseAsync keeps
// returning the same response for the whole process lifetime — a remount of
// the hook (e.g. ErrorBoundary reset) must not re-handle a stale tap.
const handledIds = new Set<string>();

export function useNotificationTapRouting(): void {
  const router = useRouter();
  const { status } = useAuth();
  // Pushing before the root navigator has mounted throws in expo-router.
  const navReady = Boolean(useRootNavigationState()?.key);
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const handle = (response: Notifications.NotificationResponse) => {
      const id = response.notification.request.identifier;
      if (handledIds.has(id)) return;
      handledIds.add(id);
      const href = resolveNotificationTarget(response);
      if (href) setPendingHref(href);
    };
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (mounted && response) handle(response);
    });
    const subscription = Notifications.addNotificationResponseReceivedListener(handle);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!pendingHref || status === 'loading' || !navReady) return;
    if (status === 'unauthenticated') {
      setPendingHref(null);
      return;
    }
    // Defer one macrotask: on a cold start the BootRedirect (app/index.tsx)
    // replaces to /(tabs) on the same auth flip — pushing after it keeps the
    // deep-link target on top instead of being clobbered by that redirect.
    const timer = setTimeout(() => {
      // The parser only emits routes that exist in app/ — safe to narrow the
      // plain string to the typed-routes Href.
      router.push(pendingHref as Href);
      setPendingHref(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [pendingHref, status, navReady, router]);
}

// Null-rendering mount point for the hook (the root layout component itself
// sits outside AuthProvider, so the hook cannot run there directly).
export function NotificationTapRouter(): null {
  useNotificationTapRouting();
  return null;
}
