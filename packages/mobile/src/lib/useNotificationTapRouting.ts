// Routes push-notification taps to the screen the payload points at. Mounted
// once in the root layout (inside AuthProvider). Covers both taps while the
// app runs (response listener) and taps that launched the app from the killed
// state (getLastNotificationResponseAsync). Navigation is gated on auth: while
// the session is still loading the target stays pending; an unauthenticated
// tap is dropped (the normal flow lands on login — no defer-through-login).
import { useEffect, useRef, useState } from 'react';
import { useRouter, type Href } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useAuth } from '@/auth/useAuth';
import { extractNotificationData, parseNotificationTarget } from '@/lib/notification-routing';

export function useNotificationTapRouting(): void {
  const router = useRouter();
  const { status } = useAuth();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  // The same tap can surface through both the cold-start read and the
  // listener (and the root layout can re-render) — handle each response
  // identifier exactly once so a tap never navigates twice.
  const handledIds = useRef(new Set<string>());

  useEffect(() => {
    let mounted = true;
    const handle = (response: Notifications.NotificationResponse) => {
      const id = response.notification.request.identifier;
      if (handledIds.current.has(id)) return;
      handledIds.current.add(id);
      const href = parseNotificationTarget(extractNotificationData(response));
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
    if (!pendingHref || status === 'loading') return;
    if (status === 'authenticated') {
      // The parser only emits routes that exist in app/ — safe to narrow the
      // plain string to the typed-routes Href.
      router.push(pendingHref as Href);
    }
    setPendingHref(null);
  }, [pendingHref, status, router]);
}

// Null-rendering mount point for the hook (the root layout component itself
// sits outside AuthProvider, so the hook cannot run there directly).
export function NotificationTapRouter(): null {
  useNotificationTapRouting();
  return null;
}
