import { getApp, getApps, initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

const rawApiKey = (import.meta.env.VITE_FIREBASE_API_KEY ?? "").trim();
const rawAuthDomain = (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "").trim();
const rawProjectId = (import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "").trim();
const rawAppId = (import.meta.env.VITE_FIREBASE_APP_ID ?? "").trim();

export const hasValidFirebaseConfig = Boolean(
  rawApiKey &&
    rawApiKey !== "your-api-key" &&
    rawProjectId &&
    rawProjectId !== "your-project-id" &&
    rawAppId &&
    rawAppId !== "your-app-id",
);

export const ALLOWED_USER_EMAIL = (
  import.meta.env.VITE_ALLOWED_USER_EMAIL || "mazurekbartosz1@gmail.com"
)
  .trim()
  .toLowerCase();

const firebaseConfig = {
  apiKey: hasValidFirebaseConfig ? rawApiKey : "AIzaSyPlaceholderKeyForMissingConfig0000",
  authDomain: rawAuthDomain || "gen-lang-client-0751515487.firebaseapp.com",
  projectId: rawProjectId || "gen-lang-client-0751515487",
  appId: rawAppId || "1:000000000000:web:0000000000000000000000",
};

export const firebaseApp =
  getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

// Backend writes to the default Firestore database `(default)`
export const db: Firestore = getFirestore(firebaseApp);

let authInstance: Auth | null = null;
try {
  authInstance = getAuth(firebaseApp);
} catch (err) {
  console.warn("Firebase Auth initialization warning:", err);
}

export const auth = authInstance as Auth;
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

export function isAllowedUser(user: User | null): boolean {
  if (!user || !user.emailVerified || !user.email) return false;
  return user.email.trim().toLowerCase() === ALLOWED_USER_EMAIL;
}

export async function signInWithGoogle() {
  if (!hasValidFirebaseConfig || !authInstance) {
    throw new Error("Brak poprawnej konfiguracji Firebase SDK (VITE_FIREBASE_*).");
  }
  return signInWithPopup(authInstance, googleProvider);
}

export async function signOutUser(): Promise<void> {
  if (!authInstance) return;
  await signOut(authInstance);
}

export function subscribeToAuthChanges(
  callback: (user: User | null) => void,
): () => void {
  if (!hasValidFirebaseConfig || !authInstance) {
    queueMicrotask(() => callback(null));
    return () => {};
  }
  return onAuthStateChanged(
    authInstance,
    (nextUser) => callback(nextUser),
    (err) => {
      console.warn("Auth listener warning:", err);
      callback(null);
    },
  );
}

export function formatFirebaseAuthError(err: unknown): string {
  const rawMsg = err instanceof Error ? err.message : String(err || "");
  const code = (err as { code?: string })?.code ?? "";
  const hostname =
    typeof window !== "undefined" && window.location?.hostname
      ? window.location.hostname
      : "twoja-domena.vercel.app";

  if (code === "auth/unauthorized-domain" || rawMsg.includes("auth/unauthorized-domain")) {
    return `Domena "${hostname}" nie jest jeszcze dodana w Firebase Auth -> Settings -> Authorized domains (projekt ${firebaseConfig.projectId}).`;
  }
  if (code === "auth/popup-closed-by-user") {
    return "Okno logowania Google zostało zamknięte przed zakończeniem.";
  }
  if (code === "auth/popup-blocked") {
    return "Przeglądarka zablokowała okno logowania Google. Zezwól na wyskakujące okna dla tej strony.";
  }
  if (code === "auth/network-request-failed") {
    return "Brak połączenia z serwerem uwierzytelniania Google. Sprawdź sieć i spróbuj ponownie.";
  }
  return rawMsg || "Nie udało się zalogować przez Google.";
}

export function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.md$/i, "");
}

export function slugToDocId(slug: string): string {
  const normalized = normalizeSlug(slug);
  return normalized.replace(/\//g, "__") || "index";
}
