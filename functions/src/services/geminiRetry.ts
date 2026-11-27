export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

export const DEFAULT_GEMINI_FALLBACK_MODELS: readonly string[] = [
  "gemini-3-flash-preview",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
];

const DEFAULT_TIMEOUT_MS = 22_000;

export function resolveGeminiModelChain(primaryOverride?: string): string[] {
  const primary =
    primaryOverride?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    DEFAULT_GEMINI_MODEL;

  const envFallbacks = process.env.GEMINI_FALLBACK_MODELS?.trim();
  const fallbacks = envFallbacks
    ? envFallbacks
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    : [...DEFAULT_GEMINI_FALLBACK_MODELS];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of [primary, ...fallbacks]) {
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

export function isRetryableGeminiError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (
    status === 404 ||
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return true;
  }

  const msg = err instanceof Error ? err.message : String(err);
  return /503|429|500|502|504|404|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|high demand|overloaded|no longer available|timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
    msg,
  );
}

async function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  model: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Gemini request timed out after ${timeoutMs}ms (model=${model})`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function callGeminiWithFallback<T>(params: {
  runForModel: (model: string) => Promise<T>;
  models?: readonly string[];
  perAttemptTimeoutMs?: number;
  maxAttemptsPerModel?: number;
  logTag?: string;
}): Promise<{ result: T; model: string }> {
  const models =
    params.models && params.models.length > 0
      ? Array.from(new Set(params.models.map((m) => m.trim()).filter(Boolean)))
      : resolveGeminiModelChain();

  const perAttemptTimeoutMs = params.perAttemptTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttemptsPerModel =
    params.maxAttemptsPerModel ?? (models.length > 1 ? 1 : 2);
  const tag = params.logTag ?? "gemini";

  let lastError: unknown;

  for (let mIdx = 0; mIdx < models.length; mIdx++) {
    const model = models[mIdx];
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      try {
        const result = await runWithTimeout(
          params.runForModel(model),
          perAttemptTimeoutMs,
          model,
        );
        return { result, model };
      } catch (err) {
        lastError = err;
        if (!isRetryableGeminiError(err)) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        const hasMoreAttempts =
          attempt < maxAttemptsPerModel || mIdx + 1 < models.length;
        if (hasMoreAttempts) {
          console.warn(
            `[${tag}] Model ${model} failed (${msg.slice(0, 140)}); falling back...`,
          );
        }
        if (attempt < maxAttemptsPerModel) {
          await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
        }
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "All Gemini models failed"));
}
