import type {
  CaptureResponse,
  GardenerRunResponse,
  PlanRunResponse,
  ResearchRunResponse,
  VaultCommandRunResponse,
  WeeklyReviewRunResponse,
} from "../types";
import { auth } from "./firebase";

function resolveApiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${cleanPath}` : cleanPath;
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const user = auth?.currentUser;
  if (!user) {
    throw new Error("Brak aktywnej sesji użytkownika.");
  }

  const idToken = await user.getIdToken();
  const res = await fetch(resolveApiUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const errMsg =
      (json && typeof json.error === "string" && json.error) ||
      `HTTP ${res.status} (${res.statusText})`;
    throw new Error(errMsg);
  }

  return (json ?? {}) as T;
}

export async function captureWebNote(params: {
  text: string;
  title?: string;
  tags?: string[];
}): Promise<CaptureResponse> {
  return apiFetch<CaptureResponse>("/api/capture", {
    method: "POST",
    body: JSON.stringify({
      source: "web",
      text: params.text,
      ...(params.title?.trim() ? { title: params.title.trim() } : {}),
      ...(params.tags && params.tags.length > 0 ? { tags: params.tags } : {}),
    }),
  });
}

export async function triggerOrganizeInbox(limit = 10): Promise<{
  ok: boolean;
  processed: number;
  skipped: number;
  errors: number;
}> {
  return apiFetch("/api/agents/organize-inbox", {
    method: "POST",
    body: JSON.stringify({ limit }),
  });
}

export async function triggerResearchForPage(
  wikiPath: string,
  force = true,
): Promise<ResearchRunResponse> {
  return apiFetch<ResearchRunResponse>("/api/agents/research", {
    method: "POST",
    body: JSON.stringify({ wikiPath, force }),
  });
}

export async function triggerPlanForPage(wikiPath: string): Promise<PlanRunResponse> {
  return apiFetch<PlanRunResponse>("/api/agents/plan", {
    method: "POST",
    body: JSON.stringify({ wikiPath }),
  });
}

export async function triggerVaultCommand(
  command: string,
): Promise<VaultCommandRunResponse> {
  return apiFetch<VaultCommandRunResponse>("/api/agents/vault-command", {
    method: "POST",
    body: JSON.stringify({ command }),
  });
}

export async function triggerGardener(): Promise<GardenerRunResponse> {
  return apiFetch<GardenerRunResponse>("/api/agents/gardener", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function triggerWeeklyReview(
  force = true,
): Promise<WeeklyReviewRunResponse> {
  return apiFetch<WeeklyReviewRunResponse>("/api/agents/weekly-review", {
    method: "POST",
    body: JSON.stringify({ force }),
  });
}
