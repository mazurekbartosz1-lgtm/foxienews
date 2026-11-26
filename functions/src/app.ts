import cors from "cors";
import express from "express";
import { requireAuth } from "./middleware/auth.js";
import {
  processAudioWithGemini,
  processTextCapture,
  type ProcessedCapture,
} from "./services/gemini.js";
import {
  commitMarkdownToVault,
  fetchVaultFileFromGitHub,
  type CommitVaultResult,
} from "./services/github.js";
import {
  createFirestoreVaultStore,
  type VaultStore,
} from "./services/firestoreStore.js";
import { buildCaptureMarkdown, buildInboxPath } from "./services/markdown.js";
import { normalizeSlug } from "./services/wikiParser.js";
import {
  syncGitHubPush,
  verifyGitHubWebhookSignature,
  type GitHubPushPayload,
} from "./services/wikiSync.js";
import type { CaptureRequest, CaptureResponse, CaptureSource } from "./types/api.js";

interface RawBodyRequest extends express.Request {
  rawBody?: Buffer;
}

const VALID_SOURCES = new Set<CaptureSource>([
  "waveshare-154",
  "reterminal-e1001",
  "web",
]);

const MAX_TEXT_LENGTH = 50_000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export interface AppDeps {
  processAudio?: (audioBase64: string, mimeType?: string) => Promise<ProcessedCapture>;
  commitToVault?: (params: {
    path: string;
    content: string;
    commitMessage: string;
  }) => Promise<CommitVaultResult>;
  vaultStore?: VaultStore;
  fetchVaultFile?: (path: string, ref?: string) => Promise<string | null>;
  now?: () => Date;
}

function normalizeAudioBase64(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^data:audio\/[a-z0-9.+-]+;base64,(.+)$/i);
  return (match ? match[1] : trimmed).replace(/\s+/g, "");
}

function isValidBase64(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9+/]+=*$/.test(value) && value.length % 4 === 0;
}

export function createApp(deps: AppDeps = {}): express.Express {
  const processAudio = deps.processAudio ?? processAudioWithGemini;
  const commitToVault = deps.commitToVault ?? commitMarkdownToVault;
  const vaultStore = deps.vaultStore ?? createFirestoreVaultStore();
  const fetchVaultFile = deps.fetchVaultFile ?? fetchVaultFileFromGitHub;
  const getNow = deps.now ?? (() => new Date());

  const app = express();

  app.use(cors({ origin: true }));
  // 15 MiB limit to accommodate Base64-encoded WAV recordings from ESP32-S3 PSRAM
  // Keep rawBody buffer for GitHub webhook HMAC-SHA256 verification
  app.use(
    express.json({
      limit: "15mb",
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf;
      },
    }),
  );

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "foxie-api" });
  });

  app.post("/api/capture", requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as Partial<CaptureRequest>;

    if (!body.source || !VALID_SOURCES.has(body.source)) {
      res.status(400).json({
        error: "Invalid or missing 'source' (expected waveshare-154 | reterminal-e1001 | web)",
      });
      return;
    }

    const hasText = typeof body.text === "string" && body.text.trim().length > 0;
    const hasAudio =
      typeof body.audioBase64 === "string" && body.audioBase64.trim().length > 0;

    if (!hasText && !hasAudio) {
      res.status(400).json({
        error: "Provide either non-empty 'text' or 'audioBase64'",
      });
      return;
    }

    if (hasText && body.text!.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ error: "Text exceeds 50000 characters limit" });
      return;
    }

    let cleanAudio = "";
    if (hasAudio) {
      if (body.mimeType && body.mimeType !== "audio/wav") {
        res.status(400).json({ error: "Unsupported mimeType (expected audio/wav)" });
        return;
      }
      cleanAudio = normalizeAudioBase64(body.audioBase64!);
      if (!isValidBase64(cleanAudio)) {
        res.status(400).json({ error: "Invalid Base64 in 'audioBase64'" });
        return;
      }
      const decodedBytes = Buffer.from(cleanAudio, "base64").byteLength;
      if (decodedBytes === 0 || decodedBytes > MAX_AUDIO_BYTES) {
        res.status(400).json({ error: "Decoded audio size out of allowed range (1 B .. 10 MiB)" });
        return;
      }
    }

    const userTags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === "string")
      : [];

    try {
      const processed = hasAudio
        ? await processAudio(cleanAudio, body.mimeType ?? "audio/wav")
        : processTextCapture(body.text!, body.title, userTags);

      const finalTitle = body.title?.trim() || processed.title;
      const mergedTags = [...processed.tags, ...userTags];
      const createdAt = getNow();

      const path = buildInboxPath({
        createdAt,
        source: body.source,
        title: finalTitle,
        vaultPrefix: process.env.GITHUB_VAULT_PREFIX,
      });

      const markdown = buildCaptureMarkdown({
        createdAt,
        source: body.source,
        type: hasAudio ? "voice-note" : "text-note",
        title: finalTitle,
        summary: processed.summary,
        body: processed.body,
        tags: mergedTags,
        tasks: processed.tasks,
      });

      const committed = await commitToVault({
        path,
        content: markdown,
        commitMessage: `capture(${body.source}): ${finalTitle}`,
      });

      const responsePayload: CaptureResponse = {
        ok: true,
        path: committed.path,
        commitSha: committed.commitSha,
        title: finalTitle,
        summary: processed.summary,
      };

      res.status(201).json(responsePayload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown capture error";
      console.error("[/api/capture] Error:", message);
      const status = message.startsWith("Missing ") ? 500 : 502;
      res.status(status).json({ error: message });
    }
  });

  // Etap 2A: Lightweight Wiki endpoints backed by Firestore cache
  app.get("/api/wiki/index", requireAuth, async (req, res) => {
    try {
      const indexDoc = (await vaultStore.getWikiIndex()) ?? {
        entries: [],
        updatedAt: "",
      };
      const query =
        typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";

      const entries = query
        ? indexDoc.entries.filter(
            (entry) =>
              entry.slug.toLowerCase().includes(query) ||
              entry.title.toLowerCase().includes(query) ||
              entry.summary.toLowerCase().includes(query) ||
              entry.tags.some((tag) => tag.toLowerCase().includes(query)),
          )
        : indexDoc.entries;

      res.json({
        entries,
        updatedAt: indexDoc.updatedAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load wiki index";
      console.error("[/api/wiki/index] Error:", message);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/wiki/page/*", requireAuth, async (req, res) => {
    const rawWildcard =
      (req.params as Record<string, string>)["0"] ??
      req.path.replace(/^\/api\/wiki\/page\/?/, "");

    let decodedSlug = "";
    try {
      decodedSlug = decodeURIComponent(rawWildcard);
    } catch {
      res.status(400).json({ error: "Malformed wiki page slug encoding" });
      return;
    }

    const slug = normalizeSlug(decodedSlug);
    if (!slug || slug.split("/").some((segment) => segment === "..")) {
      res.status(400).json({ error: "Invalid wiki page slug" });
      return;
    }

    try {
      const page = await vaultStore.getWikiPage(slug);
      if (!page) {
        res.status(404).json({ error: "Wiki page not found" });
        return;
      }

      if (req.query.format === "plain") {
        res.json({
          slug: page.slug,
          title: page.title,
          plainText: page.plainText,
          tags: page.tags,
          updatedAt: page.updatedAt,
        });
        return;
      }

      res.json(page);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load wiki page";
      console.error("[/api/wiki/page] Error:", message);
      res.status(500).json({ error: message });
    }
  });

  // Etap 2A: GitHub push webhook (verified via X-Hub-Signature-256)
  app.post("/api/webhook/github", async (req, res) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim() ?? "";
    if (!secret) {
      res.status(500).json({ error: "Missing GITHUB_WEBHOOK_SECRET configuration" });
      return;
    }

    const rawBody = (req as RawBodyRequest).rawBody;
    if (!rawBody) {
      res.status(400).json({ error: "Missing raw request body" });
      return;
    }

    const signature = req.header("x-hub-signature-256");
    if (!verifyGitHubWebhookSignature(rawBody, signature, secret)) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }

    const event = req.header("x-github-event") ?? "";
    if (event === "ping") {
      res.json({ ok: true, event: "ping" });
      return;
    }

    if (event !== "push") {
      res.json({ ok: true, ignored: true, reason: `Unsupported event '${event}'` });
      return;
    }

    const payload = (req.body ?? {}) as GitHubPushPayload;
    const targetBranch = process.env.GITHUB_BRANCH?.trim() || "main";
    const expectedRef = `refs/heads/${targetBranch}`;
    if (payload.ref && payload.ref !== expectedRef) {
      res.json({ ok: true, ignored: true, reason: `Ignored ref '${payload.ref}'` });
      return;
    }

    try {
      const result = await syncGitHubPush({
        payload,
        vaultPrefix: process.env.GITHUB_VAULT_PREFIX,
        store: vaultStore,
        fetchFile: fetchVaultFile,
        now: getNow,
      });

      res.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to sync GitHub push";
      console.error("[/api/webhook/github] Error:", message);
      res.status(502).json({ error: message });
    }
  });

  return app;
}

export const app = createApp();
