import React, { useState } from "react";
import type { User } from "firebase/auth";
import { AlertCircle, LogIn, LogOut, ShieldAlert } from "lucide-react";
import {
  ALLOWED_USER_EMAIL,
  formatFirebaseAuthError,
  hasValidFirebaseConfig,
  signInWithGoogle,
  signOutUser,
} from "../lib/firebase";
import { FoxieMark } from "./FoxieMark";

interface LoginPageProps {
  unauthorizedUser: User | null;
}

export const LoginPage: React.FC<LoginPageProps> = ({ unauthorizedUser }) => {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleGoogleLogin = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setErrorMsg(formatFirebaseAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      await signOutUser();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#F7F5F0] px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8] p-8 shadow-[0_8px_30px_rgba(28,26,24,0.05)] sm:p-10">
        <div className="flex items-center gap-3.5">
          <FoxieMark className="h-11 w-11 shrink-0" />
          <div>
            <p className="font-mono-meta text-[11px] uppercase tracking-[0.18em] text-[#7A756D]">
              Foxie Notes · Vault &amp; AI
            </p>
            <h1 className="text-2xl font-medium tracking-tight text-[#1C1A18]">
              Prywatna Baza Wiedzy
            </h1>
          </div>
        </div>

        <p className="mt-5 text-sm leading-relaxed text-[#5C574F]">
          Dostęp do notatek głosowych z Waveshare e-Paper, zadań z Obsidiana oraz
          chmurowych agentów wymaga zalogowania na autoryzowane konto Google.
        </p>

        {!hasValidFirebaseConfig ? (
          <div className="mt-6 rounded-xl border border-[#E3C7B8] bg-[#FAF0E6] p-4 text-xs leading-relaxed text-[#7F3918]">
            <p className="font-semibold">Brak konfiguracji Firebase SDK</p>
            <p className="mt-1">
              Ustaw zmienne środowiskowe w Vercel lub w pliku{" "}
              <code className="font-mono-meta">web/.env.local</code>:
            </p>
            <ul className="font-mono-meta mt-2 list-disc space-y-0.5 pl-4 text-[11px]">
              <li>VITE_FIREBASE_API_KEY</li>
              <li>VITE_FIREBASE_AUTH_DOMAIN</li>
              <li>VITE_FIREBASE_PROJECT_ID</li>
              <li>VITE_FIREBASE_APP_ID</li>
            </ul>
          </div>
        ) : unauthorizedUser ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-xl border border-[#E6B8AF] bg-[#FDF2F0] p-4 text-sm text-[#8B2E24]">
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">Brak dostępu do tego vaulta</p>
                  <p className="mt-1 text-xs leading-relaxed text-[#73312A]">
                    Zalogowano jako{" "}
                    <span className="font-mono-meta font-medium">
                      {unauthorizedUser.email || "nieznany użytkownik"}
                    </span>
                    . Dostęp jest ograniczony wyłącznie do{" "}
                    <span className="font-mono-meta">{ALLOWED_USER_EMAIL}</span>.
                  </p>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleSignOut}
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-[#D8D1C5] bg-white px-4 py-3 text-sm font-medium text-[#1C1A18] transition hover:bg-[#F2EFE8] disabled:opacity-60"
            >
              <LogOut className="h-4 w-4" />
              Wyloguj i użyj innego konta
            </button>
          </div>
        ) : (
          <div className="mt-7 space-y-4">
            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={loading}
              className="flex w-full items-center justify-center gap-3 rounded-xl bg-[#1C1A18] px-4 py-3.5 text-sm font-medium text-[#FAF9F5] transition hover:bg-[#33302B] disabled:opacity-60"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#EA4335"
                  d="M12 10.2v3.9h5.5c-.2 1.3-1.5 3.9-5.5 3.9-3.3 0-6-2.7-6-6s2.7-6 6-6c1.9 0 3.1.8 3.9 1.5l2.7-2.6C16.9 3.3 14.7 2.4 12 2.4 6.7 2.4 2.4 6.7 2.4 12S6.7 21.6 12 21.6c6.9 0 9.6-4.8 9.6-7.3 0-.5-.1-.9-.1-1.3H12z"
                />
              </svg>
              {loading ? "Logowanie..." : "Zaloguj przez Google"}
              <LogIn className="h-4 w-4 opacity-75" />
            </button>

            {errorMsg && (
              <div className="flex items-start gap-2 rounded-xl border border-[#E6B8AF] bg-[#FDF2F0] p-3 text-xs leading-relaxed text-[#8B2E24]">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}
          </div>
        )}

        <div className="mt-8 border-t border-[#ECE7DD] pt-4 text-center">
          <p className="font-mono-meta text-[11px] text-[#8E887E]">
            Whitelist: {ALLOWED_USER_EMAIL}
          </p>
        </div>
      </div>
    </div>
  );
};
