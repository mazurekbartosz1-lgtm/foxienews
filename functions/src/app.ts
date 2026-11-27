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
  createGitHubVaultClient,
  fetchVaultFileFromGitHub,
  type CommitVaultResult,
  type GitHubVaultClient,
} from "./services/github.js";
import {
  createFirestoreVaultStore,
  type VaultStore,
} from "./services/firestoreStore.js";
import {
  createGoogleWorkspaceClient,
  type GoogleWorkspaceClient,
} from "./services/googleWorkspace.js";
import {
  organizeInboxFile,
  organizePendingInboxFiles,
  type ClassifyInboxNoteFn,
} from "./services/inboxOrganizer.js";
import { buildCaptureMarkdown, buildInboxPath } from "./services/markdown.js";
import {
  runPlanningAgent,
  type EnrichActionableContextFn,
  type ExtractPlanFn,
} from "./services/planningAgent.js";
import {
  runResearchAgent,
  type GenerateResearchReportFn,
} from "./services/researchAgent.js";
import {
  runVaultCommandAgent,
  type BuildVaultCommandPlanFn,
  type SelectRelevantFilesFn,
} from "./services/vaultCommandAgent.js";
import {
  runGardenerAgent,
  type BuildGardenerPlanFn,
} from "./services/gardenerAgent.js";
import {
  runWeeklyReviewAgent,
  type GenerateWeeklyReviewFn,
} from "./services/weeklyReviewAgent.js";
import {
  runTaskReconcilerAgent,
  type MatchCompletedTasksFn,
} from "./services/taskReconciler.js";
import {
  buildWikiPageDoc,
  extractTasksFromMarkdown,
  normalizeSlug,
  parseFrontmatter,
  toggleTaskInMarkdown,
} from "./services/wikiParser.js";
import {
  extractNewInboxFilesFromPush,
  extractVaultRelativePath,
  isTaskSourceExcluded,
  syncGitHubPush,
  verifyGitHubWebhookSignature,
  type GitHubPushPayload,
} from "./services/wikiSync.js";
import type {
  CaptureRequest,
  CaptureResponse,
  CaptureSource,
  OrganizeInboxResult,
  TaskReconcilerRunResult,
  ToggleTaskResponse,
} from "./types/api.js";

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
  vaultClient?: GitHubVaultClient;
  classifyInboxNote?: ClassifyInboxNoteFn;
  enableInboxOrganizer?: boolean;
  generateResearchReport?: GenerateResearchReportFn;
  enableResearchAgent?: boolean;
  googleClient?: GoogleWorkspaceClient;
  extractPlan?: ExtractPlanFn;
  enrichContext?: EnrichActionableContextFn;
  enablePlanningAgent?: boolean;
  selectVaultCommandFiles?: SelectRelevantFilesFn;
  buildVaultCommandPlan?: BuildVaultCommandPlanFn;
  buildGardenerPlan?: BuildGardenerPlanFn;
  generateWeeklyReview?: GenerateWeeklyReviewFn;
  matchCompletedTasks?: MatchCompletedTasksFn;
  enableTaskReconciler?: boolean;
  now?: () => Date;
}

function extractVaultSyncEvidenceFromPush(
  payload: GitHubPushPayload,
  vaultPrefix = "",
): string | null {
  const commits = payload.commits ?? [];
  const hasReconcilerCommit = commits.some((c) =>
    (c.message ?? "").trim().toLowerCase().startsWith("agent(reconciler):"),
  );
  if (hasReconcilerCommit) return null;

  const syncCommits = commits.filter((c) => {
    const msg = (c.message ?? "").trim().toLowerCase();
    if (!msg.startsWith("docs(vault):")) return false;
    const touched = [...(c.added ?? []), ...(c.modified ?? [])];
    return touched.some((p) => {
      const rel = extractVaultRelativePath(p, vaultPrefix)?.toLowerCase() ?? "";
      return (
        rel === "wiki/projekty/foxie-notes/status.md" ||
        rel.startsWith("wiki/projekty/foxie-notes/zadania/")
      );
    });
  });

  if (syncCommits.length === 0) return null;
  return syncCommits
    .map((c) => (c.message ?? "").trim())
    .filter(Boolean)
    .join("\n");
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
        inboxDir: process.env.GITHUB_INBOX_DIR,
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

  app.post("/api/tasks/toggle", requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as {
      sourcePath?: unknown;
      text?: unknown;
      completed?: unknown;
    };

    const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const completed = body.completed;

    if (!sourcePath || !text || typeof completed !== "boolean") {
      res.status(400).json({
        error: "Provide non-empty 'sourcePath', 'text', and boolean 'completed'",
      });
      return;
    }

    const relativePath = extractVaultRelativePath(
      sourcePath,
      process.env.GITHUB_VAULT_PREFIX,
    );
    if (
      !relativePath ||
      relativePath.split("/").some((segment) => segment === "..") ||
      !relativePath.toLowerCase().startsWith("wiki/") ||
      !/\.md$/i.test(relativePath)
    ) {
      res.status(400).json({ error: "Invalid task sourcePath (expected wiki/*.md)" });
      return;
    }

    try {
      const client = deps.vaultClient ?? createGitHubVaultClient();
      const existing = await client.fetchFile(sourcePath);
      if (existing === null) {
        res.status(404).json({ error: `Wiki file not found: ${sourcePath}` });
        return;
      }

      const updatedAtIso = getNow().toISOString().replace(/\.\d{3}Z$/, "Z");
      const toggled = toggleTaskInMarkdown({
        markdown: existing,
        targetText: text,
        completed,
        updatedAtIso,
      });

      if (!toggled.found) {
        res.status(404).json({ error: "Task not found in source file" });
        return;
      }

      let commitSha: string | undefined;
      if (toggled.changed) {
        const commitRes = await client.commitAtomicChanges({
          commitMessage: `agent(tasks): ${completed ? "done" : "reopen"} ${text.slice(0, 60)}`,
          changes: [{ path: sourcePath, content: toggled.markdown }],
        });
        commitSha = commitRes.commitSha;

        const page = buildWikiPageDoc({
          path: sourcePath,
          relativePath,
          markdown: toggled.markdown,
          updatedAt: updatedAtIso,
        });
        await vaultStore.upsertWikiPage(page);

        const nextTasks = isTaskSourceExcluded(relativePath)
          ? []
          : extractTasksFromMarkdown({
              markdown: toggled.markdown,
              sourcePath,
              sourceSlug: page.slug,
              updatedAt: updatedAtIso,
            });
        await vaultStore.replaceTasksForSource(sourcePath, nextTasks);
      }

      const payload: ToggleTaskResponse = {
        ok: true,
        sourcePath,
        text,
        completed,
        changed: toggled.changed,
        ...(commitSha ? { commitSha } : {}),
      };
      res.json(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to toggle task";
      console.error("[/api/tasks/toggle] Error:", message);
      const status = message.startsWith("Missing ") ? 500 : 502;
      res.status(status).json({ error: message });
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

      const newInboxFiles = extractNewInboxFilesFromPush(
        payload,
        process.env.GITHUB_VAULT_PREFIX,
      );
      const canRunOrganizer =
        deps.enableInboxOrganizer !== false &&
        (Boolean(deps.vaultClient) ||
          (Boolean(process.env.GITHUB_TOKEN?.trim()) &&
            Boolean(process.env.GEMINI_API_KEY?.trim())));

      const organized: OrganizeInboxResult[] = [];
      if (newInboxFiles.length > 0 && canRunOrganizer) {
        const client = deps.vaultClient ?? createGitHubVaultClient();
        for (const inboxRepoPath of newInboxFiles) {
          try {
            const orgResult = await organizeInboxFile({
              inboxRepoPath,
              vaultClient: client,
              store: vaultStore,
              classifyNote: deps.classifyInboxNote,
              generateResearchReport: deps.generateResearchReport,
              enableResearchAgent: deps.enableResearchAgent,
              googleClient: deps.googleClient,
              extractPlan: deps.extractPlan,
              enrichContext: deps.enrichContext,
              enablePlanningAgent: deps.enablePlanningAgent,
              selectVaultCommandFiles: deps.selectVaultCommandFiles,
              buildVaultCommandPlan: deps.buildVaultCommandPlan,
              vaultPrefix: process.env.GITHUB_VAULT_PREFIX,
              now: getNow,
            });
            organized.push(orgResult);
          } catch (orgErr) {
            const orgMessage =
              orgErr instanceof Error ? orgErr.message : "Failed to organize inbox note";
            console.error("[/api/webhook/github] Organizer error:", orgMessage);
            organized.push({
              inboxPath: inboxRepoPath,
              status: "error",
              reason: orgMessage,
            });
          }
        }
      }

      let reconciled: TaskReconcilerRunResult | undefined;
      const syncEvidence = extractVaultSyncEvidenceFromPush(
        payload,
        process.env.GITHUB_VAULT_PREFIX,
      );
      const canRunReconciler =
        deps.enableTaskReconciler !== false &&
        (Boolean(deps.vaultClient) ||
          (Boolean(process.env.GITHUB_TOKEN?.trim()) &&
            Boolean(process.env.GEMINI_API_KEY?.trim())));

      if (syncEvidence && canRunReconciler) {
        try {
          const client = deps.vaultClient ?? createGitHubVaultClient();
          const gClient = deps.googleClient ?? createGoogleWorkspaceClient();
          reconciled = await runTaskReconcilerAgent({
            vaultClient: client,
            store: vaultStore,
            googleClient: gClient,
            matchCompletedTasks: deps.matchCompletedTasks,
            evidence: syncEvidence,
            vaultPrefix: process.env.GITHUB_VAULT_PREFIX,
            now: getNow,
          });
        } catch (recErr) {
          const recMessage =
            recErr instanceof Error ? recErr.message : "Failed to reconcile tasks on push";
          console.error("[/api/webhook/github] Reconciler error:", recMessage);
          reconciled = {
            status: "error",
            summary: recMessage,
            closedTasks: [],
            filesUpdated: [],
            reason: recMessage,
          };
        }
      }

      res.json({
        ok: true,
        ...result,
        ...(organized.length > 0 ? { organized } : {}),
        ...(reconciled ? { reconciled } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to sync GitHub push";
      console.error("[/api/webhook/github] Error:", message);
      res.status(502).json({ error: message });
    }
  });

  // Faza 1: Batch or on-demand Inbox Organizer agent trigger
  app.post("/api/agents/organize-inbox", requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as {
      paths?: unknown;
      limit?: unknown;
      force?: unknown;
    };

    const paths = Array.isArray(body.paths)
      ? body.paths.filter((p): p is string => typeof p === "string")
      : undefined;
    const limit =
      typeof body.limit === "number" && Number.isFinite(body.limit) && body.limit > 0
        ? Math.floor(body.limit)
        : undefined;
    const force = body.force === true;

    try {
      const client = deps.vaultClient ?? createGitHubVaultClient();
      const summary = await organizePendingInboxFiles({
        vaultClient: client,
        store: vaultStore,
        classifyNote: deps.classifyInboxNote,
        generateResearchReport: deps.generateResearchReport,
        enableResearchAgent: deps.enableResearchAgent,
        googleClient: deps.googleClient,
        extractPlan: deps.extractPlan,
        enrichContext: deps.enrichContext,
        enablePlanningAgent: deps.enablePlanningAgent,
        selectVaultCommandFiles: deps.selectVaultCommandFiles,
        buildVaultCommandPlan: deps.buildVaultCommandPlan,
        vaultPrefix: process.env.GITHUB_VAULT_PREFIX,
        paths,
        limit,
        force,
        now: getNow,
      });

      res.json({
        ok: true,
        ...summary,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to organize pending inbox files";
      console.error("[/api/agents/organize-inbox] Error:", message);
      const status = message.startsWith("Missing ") ? 500 : 502;
      res.status(status).json({ error: message });
    }
  });

  // Faza 2: On-demand Research agent (Google Search grounding -> Pull Request)
  app.post("/api/agents/research", requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as {
      title?: unknown;
      text?: unknown;
      wikiPath?: unknown;
      tags?: unknown;
      force?: unknown;
    };

    const wikiPath = typeof body.wikiPath === "string" ? body.wikiPath.trim() : "";
    const rawText = typeof body.text === "string" ? body.text.trim() : "";
    const titleHint = typeof body.title === "string" ? body.title.trim() : "";
    const extraTags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === "string")
      : [];
    const force = body.force === true;

    try {
      const client = deps.vaultClient ?? createGitHubVaultClient();

      let noteMarkdown = rawText;
      let topicTitle = titleHint;
      let targetWikiPath: string | undefined;

      if (wikiPath) {
        const fetched = await client.fetchFile(wikiPath);
        if (fetched === null) {
          res.status(404).json({ error: `Wiki file not found: ${wikiPath}` });
          return;
        }
        noteMarkdown = fetched;
        targetWikiPath = wikiPath;
        const { frontmatter, body: parsedBody } = parseFrontmatter(fetched);
        const h1Match = parsedBody.match(/^\s*#\s+(.+)$/m);
        topicTitle =
          topicTitle || frontmatter.title || (h1Match ? h1Match[1].trim() : "") || wikiPath;
      } else {
        if (!noteMarkdown) {
          res.status(400).json({ error: "Provide either non-empty 'text' or 'wikiPath'" });
          return;
        }
        if (!topicTitle) {
          const firstLine = noteMarkdown
            .split("\n")
            .map((l) => l.replace(/^#+\s*/, "").trim())
            .find(Boolean);
          topicTitle = (firstLine ?? "Research").slice(0, 80);
        }
      }

      const result = await runResearchAgent({
        topicTitle,
        noteMarkdown,
        sourcePath: targetWikiPath,
        targetWikiPath,
        extraTags,
        vaultClient: client,
        generateReport: deps.generateResearchReport,
        vaultPrefix: process.env.GITHUB_VAULT_PREFIX,
        now: getNow,
        force,
      });

      if (result.status === "error") {
        res.status(502).json({ ok: false, ...result });
        return;
      }

      res.status(result.status === "created" ? 201 : 200).json({
        ok: true,
        ...result,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to run research agent";
      console.error("[/api/agents/research] Error:", message);
      const status = message.startsWith("Missing ") ? 500 : 502;
      res.status(status).json({ error: message });
    }
  });

  // Faza 3: On-demand Planning agent (Google Calendar + Google Tasks + Google Lists)
  app.post("/api/agents/plan", requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as {
      title?: unknown;
      text?: unknown;
      wikiPath?: unknown;
    };

    const wikiPath = typeof body.wikiPath === "string" ? body.wikiPath.trim() : "";
    const rawText = typeof body.text === "string" ? body.text.trim() : "";
    const titleHint = typeof body.title === "string" ? body.title.trim() : "";

    try {
      const googleClient = deps.googleClient ?? createGoogleWorkspaceClient();
      const client =
        deps.vaultClient ??
        (process.env.GITHUB_TOKEN?.trim() &&
        process.env.GITHUB_OWNER?.trim() &&
        process.env.GITHUB_REPO?.trim()
          ? createGitHubVaultClient()
          : undefined);

      let noteMarkdown = rawText;
      let topicTitle = titleHint;
      let targetRepoPath: string | undefined;

      if (wikiPath) {
        if (!client) {
          res.status(500).json({ error: "Missing GitHub vault configuration" });
          return;
        }
        const fetched = await client.fetchFile(wikiPath);
        if (fetched === null) {
          res.status(404).json({ error: `Wiki file not found: ${wikiPath}` });
          return;
        }
        noteMarkdown = fetched;
        targetRepoPath = wikiPath;
        const { frontmatter, body: parsedBody } = parseFrontmatter(fetched);
        const h1Match = parsedBody.match(/^\s*#\s+(.+)$/m);
        topicTitle =
          topicTitle || frontmatter.title || (h1Match ? h1Match[1].trim() : "") || wikiPath;
      } else {
        if (!noteMarkdown) {
          res.status(400).json({ error: "Provide either non-empty 'text' or 'wikiPath'" });
          return;
        }
        if (!topicTitle) {
          const firstLine = noteMarkdown
            .split("\n")
            .map((l) => l.replace(/^#+\s*/, "").trim())
            .find(Boolean);
          topicTitle = (firstLine ?? "Planowanie").slice(0, 80);
        }
      }

      const result = await runPlanningAgent({
        topicTitle,
        noteMarkdown,
        sourcePath: targetRepoPath,
        targetRepoPath,
        googleClient,
        vaultClient: client,
        extractPlan: deps.extractPlan,
        enrichContext: deps.enrichContext,
        now: getNow,
      });

      if (result.status === "error") {
        res.status(502).json({ ok: false, ...result });
        return;
      }

      res.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to run planning agent";
      console.error("[/api/agents/plan] Error:", message);
      const status = message.startsWith("Missing ") ? 500 : 502;
      res.status(status).json({ error: message });
    }
  });

  // Curator Agent: Execute natural-language vault/wiki reorganization commands
  app.post("/api/agents/vault-command", requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { command?: unknown };
    const command = typeof body.command === "string" ? body.command.trim() : "";

    if (!command) {
      res.status(400).json({ error: "Missing non-empty 'command'" });
      return;
    }

    try {
      const client = deps.vaultClient ?? createGitHubVaultClient();
      const result = await runVaultCommandAgent({
        command,
        vaultClient: client,
        selectFiles: deps.selectVaultCommandFiles,
        buildPlan: deps.buildVaultCommandPlan,
        vaultPrefix: process.env.GITHUB_VAULT_PREFIX,
        now: getNow,
      });

      if (result.status === "error") {
        res.status(502).json({ ok: false, ...result });
        return;
      }

      res.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to run vault command agent";
      console.error("[/api/agents/vault-command] Error:", message);
      const status = message.startsWith("Missing ") ? 500 : 502;
      res.status(status).json({ error: message });
    }
  });

  // Scheduled / On-demand Gardener Agent: audit wiki/index.md & polish cross-links
  app.post("/api/agents/gardener", requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { skipLlm?: unknown };
    const skipLlm = body.skipLlm === true;

    try {
      const client = deps.vaultClient ?? createGitHubVaultClient();
      const result = await runGardenerAgent({
        vaultClient: client,
        buildPlan: deps.buildGardenerPlan,
        vaultPrefix: process.env.GITHUB_VAULT_PREFIX,
        skipLlm,
        now: getNow,
      });

      if (result.status === "error") {
        res.status(502).json({ ok: false, ...result });
        return;
      }

      res.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to run gardener agent";
      console.error("[/api/agents/gardener] Error:", message);
      const status = message.startsWith("Missing ") ? 500 : 502;
      res.status(status).json({ error: message });
    }
  });

  // Scheduled / On-demand Weekly Review Agent: generate wiki/dziennik/tydzien-YYYY-Www.md
  app.post("/api/agents/weekly-review", requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { force?: unknown; weekDate?: unknown };
    const force = body.force === true;
    const parsedDate =
      typeof body.weekDate === "string" && body.weekDate.trim()
        ? new Date(body.weekDate.trim())
        : null;
    if (parsedDate && Number.isNaN(parsedDate.getTime())) {
      res.status(400).json({ error: "Invalid 'weekDate' format" });
      return;
    }

    try {
      const client = deps.vaultClient ?? createGitHubVaultClient();
      const result = await runWeeklyReviewAgent({
        vaultClient: client,
        generateReview: deps.generateWeeklyReview,
        vaultPrefix: process.env.GITHUB_VAULT_PREFIX,
        force,
        now: parsedDate ? () => parsedDate : getNow,
      });

      if (result.status === "error") {
        res.status(502).json({ ok: false, ...result });
        return;
      }

      res.status(result.status === "created" ? 201 : 200).json({
        ok: true,
        ...result,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to run weekly review agent";
      console.error("[/api/agents/weekly-review] Error:", message);
      const status = message.startsWith("Missing ") ? 500 : 502;
      res.status(status).json({ error: message });
    }
  });

  // Reconciler Agent: automatically close completed tasks based on commits, logs & Google Tasks
  app.post("/api/agents/reconcile-tasks", requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as {
      evidence?: unknown;
      skipLlm?: unknown;
      skipGoogle?: unknown;
      dryRun?: unknown;
    };

    const evidence = typeof body.evidence === "string" ? body.evidence.trim() : undefined;
    const skipLlm = body.skipLlm === true;
    const skipGoogle = body.skipGoogle === true;
    const dryRun = body.dryRun === true;

    try {
      const client = deps.vaultClient ?? createGitHubVaultClient();
      const gClient = deps.googleClient ?? createGoogleWorkspaceClient();
      const result = await runTaskReconcilerAgent({
        vaultClient: client,
        store: vaultStore,
        googleClient: gClient,
        matchCompletedTasks: deps.matchCompletedTasks,
        evidence,
        skipLlm,
        skipGoogle,
        dryRun,
        vaultPrefix: process.env.GITHUB_VAULT_PREFIX,
        now: getNow,
      });

      if (result.status === "error") {
        res.status(502).json({ ok: false, ...result });
        return;
      }

      res.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to run task reconciler agent";
      console.error("[/api/agents/reconcile-tasks] Error:", message);
      const status = message.startsWith("Missing ") ? 500 : 502;
      res.status(status).json({ error: message });
    }
  });

  return app;
}

export const app = createApp();
