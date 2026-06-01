import type { ReactNode } from 'react';

// Branded auth shell shared by Login / ForgotPassword / ResetPassword.
// Extracted from Login.tsx (3rd auth consumer = correct DRY trigger).
// Children render inside the frosted card.
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen relative bg-[radial-gradient(ellipse_at_center,#1a3358_0%,#0d1f3a_70%,#081428_100%)] flex flex-col">
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-6xl mx-auto md:grid md:grid-cols-2 md:gap-12 md:items-center">
          <div className="flex flex-col items-center gap-4 mb-8 md:mb-0">
            <img
              src="/garageos-logo.png"
              alt="GarageOS — Digital Maintenance Logs"
              width={644}
              height={644}
              className="max-w-[200px] md:max-w-[260px] h-auto"
            />
            <p className="text-slate-300 text-base md:text-lg text-center max-w-md">
              Il libretto di manutenzione digitale per la tua officina
            </p>
          </div>
          <div className="w-full max-w-sm mx-auto md:max-w-md md:mx-0">
            <div className="bg-white/[0.06] backdrop-blur-md border border-white/[0.12] rounded-lg p-6 md:p-8">
              {children}
            </div>
          </div>
        </div>
      </main>
      <footer className="py-6 px-4 flex flex-col items-center gap-2 border-t border-white/[0.05]">
        <img
          src="/aifolly-logo.png"
          alt="Powered by AI Folly"
          width={1376}
          height={768}
          className="max-w-[60px] h-auto opacity-75"
        />
        <p className="text-slate-500 text-xs">
          &copy; 2026 AI Folly Srl &mdash; Tutti i diritti riservati
        </p>
      </footer>
    </div>
  );
}
