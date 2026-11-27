import crypto from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { callGeminiWithFallback } from "./geminiRetry.js";
import type {
  ClosedTaskRecord,
  TaskReconcilerRunResult,
} from "../types/api.js";
import type { VaultStore } from "./firestoreStore.js";
import type { AtomicFileChange, GitHubVaultClient } from "./github.js";
import type { GoogleTaskItem, GoogleWorkspaceClient } from "./googleWorkspace.js";
import { slugifyPolish } from "./markdown.js";
import {
  buildWikiPageDoc,
  cleanTaskLineText,
  extractTasksFromMarkdown,
  toggleTaskInMarkdown,
} from "./wikiParser.js";
import { extractVaultRelativePath, isTaskSourceExcluded } from "./wikiSync.js";

const DEFAULT_MODEL = "gemini-3.8-flash";
const MIN_EVIDENCE_CONFIDENCE = 0.85;
const RESEARCH_TASK_REGEX =
  /(?:^|[\s(["'])(?:research|risercz|zbadac|zbadać)(?=$|[\s.,:;!?)\]"'])/i;

export interface OpenVaultTaskCandidate {
  sourcePath: string;
  repoPath: string;
  text: string;
}

export interface EvidenceClosureProposal {
  sourcePath: string;
  text: string;
  confidence: number;
  reason: string;
}

export type MatchCompletedTasksFn = (input: {
  noteDate: string;
  openTasks: Array<{ sourcePath: string; text: string }>;
  evidenceText: string;
}) => Promise<{ summary: string; closures: EvidenceClosureProposal[] }>;

function joinRepoPath(prefix: string | undefined, relativePath: string): string {
  const cleanPrefix = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  const cleanRel = relativePath.replace(/^\/+/, "");
  return cleanPrefix ? `${cleanPrefix}/${cleanRel}` : cleanRel;
}

function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function isTransientGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/i.test(msg);
}

/**
 * Editable wiki paths where the Task Reconciler is allowed to flip `- [ ]` -> `- [x]`.
 * Protected system/synced docs (`status.md`, `index.md`, `sprzet-waveshare-v2.md`, `zadania/**`)
 * are excluded as write targets (they remain read-only evidence sources), while `notatki.md`
 * and all personal/idea/journal pages are editable.
 */
export function isReconcilableWikiPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  if (!norm.startsWith("wiki/") || !/\.md$/i.test(norm)) return false;
  if (norm === "wiki/index.md" || norm === "wiki/log.md") return false;
  if (/(^|\/)research\.md$/i.test(norm)) return false;
  if (/^wiki\/dziennik\/tydzien-/i.test(norm)) return false;
  if (norm === "wiki/projekty/foxie-notes/status.md") return false;
  if (norm === "wiki/projekty/foxie-notes/index.md") return false;
  if (norm === "wiki/projekty/foxie-notes/sprzet-waveshare-v2.md") return false;
  if (norm.startsWith("wiki/projekty/foxie-notes/zadania/")) return false;
  return true;
}

function normalizeForMatch(raw: string): string {
  return slugifyPolish(
    raw
      .replace(/@due\(\d{4}-\d{2}-\d{2}\)/gi, " ")
      .replace(/#[A-Za-z0-9_\-ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]+/g, " ")
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1"),
  ).replace(/-/g, " ");
}

function meaningfulTokens(raw: string): string[] {
  return normalizeForMatch(raw)
    .split(" ")
    .filter((tok) => tok.length > 2);
}

/**
 * Layer 1 (deterministic, zero LLM): closes tasks with indisputable structural proof:
 * 1) Parent page has sibling `research.md` or `## Powiązany research`, yet still has open `- [ ] ...research...`
 * 2) Same page already has the exact same task marked `- [x]`
 */
export function findDeterministicClosures(
  filesByRelPath: Map<string, string>,
  allWikiRelPaths: readonly string[],
): Array<{ relPath: string; text: string; reason: string; via: "deterministic" }> {
  const existingRelSet = new Set(
    allWikiRelPaths.map((p) => p.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase()),
  );
  const closures: Array<{
    relPath: string;
    text: string;
    reason: string;
    via: "deterministic";
  }> = [];

  for (const [relPath, markdown] of filesByRelPath.entries()) {
    if (!isReconcilableWikiPath(relPath)) continue;

    const normalized = markdown.replace(/\r\n/g, "\n");
    const baseWithoutExt = relPath.replace(/\.md$/i, "");
    const expectedResearchRel = `${baseWithoutExt}/research.md`.toLowerCase();
    const hasSiblingResearch =
      existingRelSet.has(expectedResearchRel) ||
      /^##\s+Powiązany research\b/im.test(normalized);

    const parsedTasks = extractTasksFromMarkdown({
      markdown: normalized,
      sourcePath: relPath,
      updatedAt: "",
    });

    const completedSet = new Set(
      parsedTasks
        .filter((t) => t.completed)
        .map((t) => t.text.replace(/\s+/g, " ").trim().toLowerCase()),
    );

    const seenForPage = new Set<string>();
    for (const task of parsedTasks) {
      if (task.completed) continue;
      const key = task.text.replace(/\s+/g, " ").trim().toLowerCase();
      if (seenForPage.has(key)) continue;

      if (completedSet.has(key)) {
        seenForPage.add(key);
        closures.push({
          relPath,
          text: task.text,
          reason: "Duplikat zadania ukończonego już na tej stronie",
          via: "deterministic",
        });
        continue;
      }

      if (hasSiblingResearch && RESEARCH_TASK_REGEX.test(task.text)) {
        seenForPage.add(key);
        closures.push({
          relPath,
          text: task.text,
          reason: "Raport research.md został już utworzony i podpięty",
          via: "deterministic",
        });
      }
    }
  }

  return closures;
}

/**
 * Layer 2 (Google Tasks two-way completion sync): matches completed Google Tasks
 * against open vault tasks.
 */
export function matchCompletedGoogleTasks(
  openTasks: readonly OpenVaultTaskCandidate[],
  completedGoogleTasks: readonly GoogleTaskItem[],
): Array<{ relPath: string; text: string; reason: string; via: "google-tasks" }> {
  if (openTasks.length === 0 || completedGoogleTasks.length === 0) return [];

  const completedPrepared = completedGoogleTasks
    .filter((gt) => gt.status === "completed" && gt.title.trim())
    .map((gt) => ({
      item: gt,
      norm: normalizeForMatch(gt.title),
      tokens: new Set(meaningfulTokens(gt.title)),
    }))
    .filter((entry) => entry.norm.length >= 4);

  const closures: Array<{
    relPath: string;
    text: string;
    reason: string;
    via: "google-tasks";
  }> = [];

  for (const open of openTasks) {
    const openNorm = normalizeForMatch(open.text);
    const openTokens = meaningfulTokens(open.text);
    if (!openNorm || openTokens.length === 0) continue;

    let matched: (typeof completedPrepared)[number] | undefined;
    for (const cand of completedPrepared) {
      if (cand.norm === openNorm) {
        matched = cand;
        break;
      }
      if (
        openNorm.length >= 12 &&
        cand.norm.length >= 12 &&
        (openNorm.includes(cand.norm) || cand.norm.includes(openNorm))
      ) {
        matched = cand;
        break;
      }
      const intersection = openTokens.filter((t) => cand.tokens.has(t)).length;
      const minSize = Math.min(openTokens.length, cand.tokens.size);
      const ratio = minSize > 0 ? intersection / minSize : 0;
      if (intersection >= 3 && ratio >= 0.72) {
        matched = cand;
        break;
      }
    }

    if (matched) {
      closures.push({
        relPath: open.sourcePath,
        text: open.text,
        reason: `Ukończono w Google Tasks (${matched.item.listTitle || "Moje zadania"})`,
        via: "google-tasks",
      });
    }
  }

  return closures;
}

async function fetchCompletedGoogleTasks(
  googleClient?: GoogleWorkspaceClient,
): Promise<GoogleTaskItem[]> {
  if (!googleClient || !googleClient.isConfigured() || !googleClient.listTasks) {
    return [];
  }

  try {
    let lists = await googleClient.listTaskLists();
    if (lists.length === 0) {
      lists = [{ id: "@default", title: "Moje zadania" }];
    }
    const results = await Promise.all(
      lists.slice(0, 6).map(async (list) => {
        try {
          return await googleClient.listTasks!({
            listId: list.id,
            listTitle: list.title,
            showCompleted: true,
            showHidden: true,
          });
        } catch {
          return [];
        }
      }),
    );
    return results.flat().filter((item) => item.status === "completed");
  } catch (err) {
    console.warn(
      "[taskReconciler] Google Tasks fetch skipped:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

export async function matchTasksWithEvidenceGemini(input: {
  noteDate: string;
  openTasks: Array<{ sourcePath: string; text: string }>;
  evidenceText: string;
}): Promise<{ summary: string; closures: EvidenceClosureProposal[] }> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY for TaskReconciler");
  }

  const ai = new GoogleGenAI({ apiKey });

  const tasksBlock = input.openTasks
    .map((t) => `- [${t.sourcePath}] ${t.text}`)
    .join("\n");

  const prompt = [
    "Jesteś Agentem Zamykaczem Zadań (Task Reconciler) w bazie wiedzy Obsidian Foxie Notes.",
    `Dzisiejsza data: ${input.noteDate}.`,
    "",
    "Otrzymujesz listę otwartych zadań `- [ ]` oraz materiał dowodowy z ostatnich commitów, `wiki/log.md`, `status.md`, list ukończonych zadań `[x]` oraz ostatnich dniówek.",
    "Twoje zadanie: wskaż WYŁĄCZNIE te otwarte zadania, dla których w materiale dowodowym istnieje jednoznaczny, konkretny dowód wykonania, wdrożenia albo zastąpienia (pewność >= 0.85).",
    "",
    "ZASADY BEZWZGLĘDNE:",
    "1. NIGDY nie zgaduj i nie zamykaj bieżących zadań osobistych bez wyraźnego dowodu w tekście.",
    "2. W `sourcePath` oraz `text` zwracaj DOKŁADNĄ ścieżkę i DOKŁADNY tekst zadania z listy otwartych zadań.",
    "3. Jeśli żadne otwarte zadanie nie ma jednoznacznego dowodu wykonania, zwróć `closures: []`.",
    "",
    "OTWARTE ZADANIA:",
    tasksBlock || "(brak)",
    "",
    "MATERIAŁ DOWODOWY:",
    input.evidenceText.slice(0, 14000) || "(brak)",
    "",
    "Zwróć WYŁĄCZNIE poprawny obiekt JSON:",
    "{",
    '  "summary": "Krótkie podsumowanie po polsku (max 140 znaków)",',
    '  "closures": [',
    "    {",
    '      "sourcePath": "wiki/...",',
    '      "text": "dokładny tekst zadania",',
    '      "confidence": 0.95,',
    '      "reason": "krótki dowód po polsku"',
    "    }",
    "  ]",
    "}",
  ].join("\n");

  const { result: response } = await callGeminiWithFallback({
    logTag: "taskReconciler",
    perAttemptTimeoutMs: 25_000,
    runForModel: (model) =>
      ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
  });

  const parsed = JSON.parse(stripJsonFences(response?.text ?? "{}")) as {
    summary?: unknown;
    closures?: unknown;
  };

  const closures: EvidenceClosureProposal[] = [];
  if (Array.isArray(parsed.closures)) {
    for (const raw of parsed.closures) {
      if (!raw || typeof raw !== "object") continue;
      const obj = raw as Record<string, unknown>;
      const sourcePath = typeof obj.sourcePath === "string" ? obj.sourcePath.trim() : "";
      const text = typeof obj.text === "string" ? obj.text.trim() : "";
      const confidence =
        typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
          ? obj.confidence
          : 0;
      const reason =
        typeof obj.reason === "string" && obj.reason.trim()
          ? obj.reason.trim()
          : "Potwierdzone przez materiał dowodowy.";
      if (sourcePath && text) {
        closures.push({ sourcePath, text, confidence, reason });
      }
    }
  }

  return {
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : "Przejrzano otwarte zadania pod kątem dowodów ukończenia.",
    closures,
  };
}

export function prependReconcilerLogMarkdown(params: {
  existingLogMarkdown: string | null;
  dateStr: string;
  updatedAtIso: string;
  closedTasks: readonly ClosedTaskRecord[];
}): string {
  const base = (
    params.existingLogMarkdown ??
    `---
title: Dziennik zmian
slug: log
updated_at: ${params.updatedAtIso}
tags: [log]
---

# Dziennik zmian (LLM Wiki & Rozwój Projektu)
`
  ).replace(/\r\n/g, "\n");

  const withTimestamp = /^updated_at\s*:/m.test(base)
    ? base.replace(/^updated_at:\s*.*$/m, `updated_at: ${params.updatedAtIso}`)
    : base;

  const uniqueSlugs = Array.from(
    new Set(
      params.closedTasks.map((c) => c.sourcePath.replace(/^wiki\//i, "").replace(/\.md$/i, "")),
    ),
  )
    .slice(0, 4)
    .map((s) => `[[${s}]]`)
    .join(", ");

  const preview = params.closedTasks
    .slice(0, 3)
    .map((c) => `„${c.text.slice(0, 60)}”`)
    .join(", ");
  const extra = params.closedTasks.length > 3 ? ` (+${params.closedTasks.length - 3})` : "";

  const line = `- **Agent Reconciler (\`reconciler\`):** Automatycznie zamknięto ${params.closedTasks.length} zadań (${preview}${extra}; strony: ${uniqueSlugs}).`;
  const dayHeading = `## ${params.dateStr}`;

  if (withTimestamp.includes(dayHeading)) {
    const idx = withTimestamp.indexOf(dayHeading);
    const afterHeading = idx + dayHeading.length;
    const before = withTimestamp.slice(0, afterHeading);
    const after = withTimestamp.slice(afterHeading);
    return `${before}\n${line}${after.startsWith("\n") ? after : `\n${after}`}`;
  }

  const firstH1Match = withTimestamp.match(/^#\s+.+\n*/m);
  if (firstH1Match && firstH1Match.index !== undefined) {
    const insertAt = firstH1Match.index + firstH1Match[0].length;
    const before = withTimestamp.slice(0, insertAt).trimEnd();
    const after = withTimestamp.slice(insertAt).trimStart();
    return `${before}\n\n${dayHeading}\n${line}${after ? `\n\n${after}` : "\n"}`;
  }

  return `${withTimestamp.trimEnd()}\n\n${dayHeading}\n${line}\n`;
}

function buildEvidenceFingerprint(
  treeEntries: Array<{ path: string; sha: string; type: string }>,
  vaultPrefix?: string,
): string {
  const relevant = treeEntries
    .filter((entry) => entry.type === "blob" && /\.md$/i.test(entry.path))
    .map((entry) => ({
      sha: entry.sha,
      rel: extractVaultRelativePath(entry.path, vaultPrefix),
    }))
    .filter(
      (item): item is { sha: string; rel: string } =>
        Boolean(
          item.rel &&
            (item.rel === "wiki/log.md" ||
              item.rel.startsWith("wiki/projekty/foxie-notes/") ||
              item.rel.startsWith("wiki/dziennik/")),
        ),
    )
    .sort((a, b) => a.rel.localeCompare(b.rel));

  const hash = crypto.createHash("sha1");
  for (const item of relevant) {
    hash.update(`${item.rel}:${item.sha}\n`);
  }
  return hash.digest("hex");
}

function buildEvidenceText(params: {
  callerEvidence?: string;
  logMd: string | null;
  evidenceFiles: Array<{ relPath: string; content: string }>;
}): string {
  const parts: string[] = [];

  if (params.callerEvidence?.trim()) {
    parts.push("=== DODATKOWY KONTEKST / COMMITS ===", params.callerEvidence.trim());
  }

  if (params.logMd) {
    const topLog = params.logMd.replace(/\r\n/g, "\n").split("\n").slice(0, 120).join("\n");
    parts.push("=== OSTATNIE WPISY wiki/log.md ===", topLog);
  }

  for (const file of params.evidenceFiles) {
    if (file.relPath.includes("/zadania/")) {
      const doneLines = file.content
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((line) => /^\s*[-*]\s+\[[xX]\]\s+/.test(line));
      if (doneLines.length > 0) {
        parts.push(`=== UKOŃCZONE W ${file.relPath} ===`, doneLines.join("\n"));
      }
    } else {
      parts.push(`=== PLIK DOWODOWY: ${file.relPath} ===`, file.content.slice(0, 5000));
    }
  }

  return parts.join("\n\n");
}

export async function runTaskReconcilerAgent(params: {
  vaultClient: GitHubVaultClient;
  store?: VaultStore;
  googleClient?: GoogleWorkspaceClient;
  matchCompletedTasks?: MatchCompletedTasksFn;
  evidence?: string;
  vaultPrefix?: string;
  skipLlm?: boolean;
  skipGoogle?: boolean;
  skipLlmIfUnchanged?: boolean;
  dryRun?: boolean;
  now?: () => Date;
}): Promise<TaskReconcilerRunResult> {
  const nowDate = params.now ? params.now() : new Date();
  const nowIso = nowDate.toISOString().replace(/\.\d{3}Z$/, "Z");
  const noteDate = nowIso.slice(0, 10);
  const matchFn = params.matchCompletedTasks ?? matchTasksWithEvidenceGemini;

  try {
    const treeEntries = await params.vaultClient.listTree();
    const allWikiRelPaths = treeEntries
      .filter((e) => e.type === "blob" && /\.md$/i.test(e.path))
      .map((e) => extractVaultRelativePath(e.path, params.vaultPrefix))
      .filter((rel): rel is string => Boolean(rel && rel.startsWith("wiki/")))
      .sort();

    const reconcilablePaths = allWikiRelPaths.filter(isReconcilableWikiPath);
    const journalPaths = allWikiRelPaths
      .filter((rel) => /^wiki\/dziennik\/\d{4}-\d{2}-\d{2}\.md$/i.test(rel))
      .sort()
      .reverse()
      .slice(0, 3);
    const evidenceRelPaths = Array.from(
      new Set([
        ...allWikiRelPaths.filter(
          (rel) =>
            rel === "wiki/projekty/foxie-notes/status.md" ||
            rel.startsWith("wiki/projekty/foxie-notes/zadania/"),
        ),
        ...journalPaths,
      ]),
    );

    const logRepoPath = joinRepoPath(params.vaultPrefix, "wiki/log.md");
    const uniqueFetchRelPaths = Array.from(
      new Set([...reconcilablePaths, ...evidenceRelPaths]),
    );

    const [logMd, ...fetchedEntries] = await Promise.all([
      params.vaultClient.fetchFile(logRepoPath),
      ...uniqueFetchRelPaths.map(async (rel) => ({
        rel,
        content: await params.vaultClient.fetchFile(joinRepoPath(params.vaultPrefix, rel)),
      })),
    ]);

    const filesByRelPath = new Map<string, string>();
    for (const entry of fetchedEntries) {
      if (entry.content !== null) {
        filesByRelPath.set(entry.rel, entry.content);
      }
    }

    // Extract open tasks from reconcilable files
    const openTasks: OpenVaultTaskCandidate[] = [];
    for (const relPath of reconcilablePaths) {
      const md = filesByRelPath.get(relPath);
      if (!md) continue;
      const extracted = extractTasksFromMarkdown({
        markdown: md,
        sourcePath: joinRepoPath(params.vaultPrefix, relPath),
        updatedAt: nowIso,
      });
      for (const task of extracted) {
        if (!task.completed) {
          openTasks.push({
            sourcePath: relPath,
            repoPath: joinRepoPath(params.vaultPrefix, relPath),
            text: task.text,
          });
        }
      }
    }

    if (openTasks.length === 0) {
      return {
        status: "skipped",
        summary: "Brak otwartych zadań do uporządkowania.",
        closedTasks: [],
        filesUpdated: [],
        reason: "no_open_tasks",
      };
    }

    // Layer 1: Deterministic
    const plannedClosures: ClosedTaskRecord[] = [];
    const seenKeys = new Set<string>();
    const addClosure = (record: ClosedTaskRecord) => {
      const key = `${record.sourcePath}\n${record.text}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      plannedClosures.push(record);
    };

    for (const c of findDeterministicClosures(filesByRelPath, allWikiRelPaths)) {
      addClosure({
        sourcePath: c.relPath,
        text: c.text,
        reason: c.reason,
        via: "deterministic",
      });
    }

    // Layer 2: Google Tasks two-way sync
    if (!params.skipGoogle) {
      const remainingAfterDet = openTasks.filter(
        (t) => !seenKeys.has(`${t.sourcePath}\n${t.text}`),
      );
      const completedGoogle = await fetchCompletedGoogleTasks(params.googleClient);
      for (const c of matchCompletedGoogleTasks(remainingAfterDet, completedGoogle)) {
        addClosure({
          sourcePath: c.relPath,
          text: c.text,
          reason: c.reason,
          via: "google-tasks",
        });
      }
    }

    // Layer 3: Evidence-based LLM reconciler
    const fingerprint = buildEvidenceFingerprint(treeEntries, params.vaultPrefix);
    let shouldRunLlm = !params.skipLlm;
    if (shouldRunLlm && params.skipLlmIfUnchanged && params.store && !params.evidence?.trim()) {
      const prevState = await params.store.getReconcilerState();
      if (prevState?.lastHeadSha === fingerprint) {
        shouldRunLlm = false;
      }
    }

    let llmSummary = "";
    const remainingOpen = openTasks.filter(
      (t) => !seenKeys.has(`${t.sourcePath}\n${t.text}`),
    );
    if (shouldRunLlm && remainingOpen.length > 0) {
      const evidenceFiles = evidenceRelPaths
        .map((rel) => ({ relPath: rel, content: filesByRelPath.get(rel) }))
        .filter((item): item is { relPath: string; content: string } => Boolean(item.content));

      const evidenceText = buildEvidenceText({
        callerEvidence: params.evidence,
        logMd,
        evidenceFiles,
      });

      const llmRes = await matchFn({
        noteDate,
        openTasks: remainingOpen.map((t) => ({
          sourcePath: t.sourcePath,
          text: t.text,
        })),
        evidenceText,
      });
      llmSummary = llmRes.summary;

      const openTaskSet = new Set(
        remainingOpen.map((t) => `${t.sourcePath}\n${cleanTaskLineText(t.text).cleanText}`),
      );

      for (const proposal of llmRes.closures) {
        if (proposal.confidence < MIN_EVIDENCE_CONFIDENCE) continue;
        const rel = extractVaultRelativePath(proposal.sourcePath, params.vaultPrefix) ?? proposal.sourcePath;
        if (!isReconcilableWikiPath(rel)) continue;
        const cleanProposalText = cleanTaskLineText(proposal.text).cleanText;
        if (!openTaskSet.has(`${rel}\n${cleanProposalText}`)) continue;

        addClosure({
          sourcePath: rel,
          text: cleanProposalText,
          reason: proposal.reason,
          via: "llm-evidence",
        });
      }
    }

    // Apply closures in-memory first to verify actual diffs
    const updatedFiles = new Map<string, string>();
    const appliedClosures: ClosedTaskRecord[] = [];

    for (const closure of plannedClosures) {
      const currentMd = updatedFiles.get(closure.sourcePath) ?? filesByRelPath.get(closure.sourcePath);
      if (!currentMd) continue;

      const toggled = toggleTaskInMarkdown({
        markdown: currentMd,
        targetText: closure.text,
        completed: true,
        updatedAtIso: nowIso,
      });

      if (toggled.found && toggled.changed) {
        updatedFiles.set(closure.sourcePath, toggled.markdown);
        appliedClosures.push(closure);
      }
    }

    const filesUpdated = Array.from(updatedFiles.keys()).sort();

    if (params.dryRun) {
      return {
        status: appliedClosures.length > 0 ? "executed" : "skipped",
        summary:
          appliedClosures.length > 0
            ? `Podgląd: znaleziono ${appliedClosures.length} zadań do zamknięcia.`
            : "Brak zadań do automatycznego zamknięcia.",
        closedTasks: appliedClosures,
        filesUpdated,
        ...(appliedClosures.length === 0 ? { reason: "no_completed_tasks_found" } : {}),
      };
    }

    if (appliedClosures.length === 0) {
      if (params.store) {
        await params.store.saveReconcilerState({
          lastRunAt: nowIso,
          lastHeadSha: fingerprint,
          lastClosedCount: 0,
        });
      }
      return {
        status: "skipped",
        summary: "Wszystkie otwarte zadania są nadal aktualne.",
        closedTasks: [],
        filesUpdated: [],
        reason: "no_completed_tasks_found",
      };
    }

    const nextLogMd = prependReconcilerLogMarkdown({
      existingLogMarkdown: logMd,
      dateStr: noteDate,
      updatedAtIso: nowIso,
      closedTasks: appliedClosures,
    });

    const changes: AtomicFileChange[] = filesUpdated.map((rel) => ({
      path: joinRepoPath(params.vaultPrefix, rel),
      content: updatedFiles.get(rel)!,
    }));
    changes.push({ path: logRepoPath, content: nextLogMd });

    const { commitSha } = await params.vaultClient.commitAtomicChanges({
      commitMessage: `agent(reconciler): closed ${appliedClosures.length} completed task(s)`,
      changes,
    });

    if (params.store) {
      for (const rel of filesUpdated) {
        const repoPath = joinRepoPath(params.vaultPrefix, rel);
        const markdown = updatedFiles.get(rel)!;
        const page = buildWikiPageDoc({
          path: repoPath,
          relativePath: rel,
          markdown,
          updatedAt: nowIso,
        });
        await params.store.upsertWikiPage(page);
        const nextTasks = isTaskSourceExcluded(rel)
          ? []
          : extractTasksFromMarkdown({
              markdown,
              sourcePath: repoPath,
              sourceSlug: page.slug,
              updatedAt: nowIso,
            });
        await params.store.replaceTasksForSource(repoPath, nextTasks);
      }

      const nextTree = await params.vaultClient.listTree();
      const nextFingerprint = buildEvidenceFingerprint(nextTree, params.vaultPrefix);
      await params.store.saveReconcilerState({
        lastRunAt: nowIso,
        lastHeadSha: nextFingerprint,
        lastClosedCount: appliedClosures.length,
      });
    }

    const summary =
      llmSummary ||
      `Automatycznie zamknięto ${appliedClosures.length} ukończonych zadań.`;

    return {
      status: "executed",
      summary,
      closedTasks: appliedClosures,
      filesUpdated,
      commitSha,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "TaskReconciler execution failed";
    return {
      status: "error",
      summary: message,
      closedTasks: [],
      filesUpdated: [],
      reason: message,
    };
  }
}
