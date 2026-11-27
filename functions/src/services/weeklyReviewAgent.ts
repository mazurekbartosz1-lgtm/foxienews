import { GoogleGenAI } from "@google/genai";
import type { WeeklyReviewRunResult } from "../types/api.js";
import { callGeminiWithFallback } from "./geminiRetry.js";
import type { AtomicFileChange, GitHubVaultClient } from "./github.js";
import { updateWikiIndexMarkdown } from "./inboxOrganizer.js";
import { extractTasksFromMarkdown, parseFrontmatter } from "./wikiParser.js";
import { extractVaultRelativePath } from "./wikiSync.js";

const DEFAULT_MODEL = "gemini-3.8-flash";
const MAX_ACTIVE_SCAN_FILES = 20;

export interface IsoWeekInfo {
  isoYear: number;
  isoWeek: number;
  weekKey: string;
  startDate: string;
  endDate: string;
}

export interface GenerateWeeklyReviewInput {
  weekKey: string;
  startDate: string;
  endDate: string;
  journals: Array<{ path: string; content: string }>;
  recentLogSection: string;
  openTasks: Array<{ slug: string; text: string; dueDate?: string }>;
  ideas: Array<{ slug: string; title: string; summary: string }>;
}

export type GenerateWeeklyReviewFn = (
  input: GenerateWeeklyReviewInput,
) => Promise<{ summary: string; bodyMarkdown: string }>;

function joinRepoPath(prefix: string | undefined, relativePath: string): string {
  const cleanPrefix = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  const cleanRel = relativePath.replace(/^\/+/, "");
  return cleanPrefix ? `${cleanPrefix}/${cleanRel}` : cleanRel;
}

function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json|markdown|md)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function isTransientGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/i.test(msg);
}

export function getIsoWeekInfo(date: Date): IsoWeekInfo {
  const utc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = utc.getUTCDay() || 7; // Monday=1 .. Sunday=7
  const monday = new Date(utc);
  monday.setUTCDate(utc.getUTCDate() - (dayNum - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  // ISO year is determined by the Thursday of this week
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const isoYear = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(
    ((thursday.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7,
  );

  const weekStr = String(isoWeek).padStart(2, "0");
  return {
    isoYear,
    isoWeek,
    weekKey: `${isoYear}-W${weekStr}`,
    startDate: monday.toISOString().slice(0, 10),
    endDate: sunday.toISOString().slice(0, 10),
  };
}

export function prependWeeklyReviewLogMarkdown(params: {
  existingLogMarkdown: string | null;
  dateStr: string;
  updatedAtIso: string;
  weekKey: string;
  reportSlug: string;
  summary: string;
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

  const line = `- **Agent Przegląd Tygodniowy (\`weekly-review\`):** Wygenerowano przegląd tygodnia ${params.weekKey}: ${params.summary} ([[${params.reportSlug}|Przegląd tygodniowy ${params.weekKey}]]).`;
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

export async function generateWeeklyReviewWithGemini(
  input: GenerateWeeklyReviewInput,
): Promise<{ summary: string; bodyMarkdown: string }> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY for WeeklyReviewAgent");
  }

  const ai = new GoogleGenAI({ apiKey });

  const journalsText =
    input.journals.length > 0
      ? input.journals
          .map((j) => `=== ${j.path} ===\n${j.content.slice(0, 3000)}`)
          .join("\n\n")
      : "(brak dzienników z tego tygodnia)";

  const tasksText =
    input.openTasks.length > 0
      ? input.openTasks
          .slice(0, 40)
          .map(
            (t) =>
              `- [ ] ${t.text}${t.dueDate ? ` (@due ${t.dueDate})` : ""} [źródło: [[${t.slug}]]]`,
          )
          .join("\n")
      : "(brak otwartych zadań)";

  const ideasText =
    input.ideas.length > 0
      ? input.ideas
          .map((idea) => `- [[${idea.slug}|${idea.title}]]: ${idea.summary}`)
          .join("\n")
      : "(brak aktywnych pomysłów)";

  const prompt = [
    "Jesteś Agentem Przeglądu Tygodniowego prywatnej bazy wiedzy Obsidian (Foxie Notes).",
    `Tydzień ISO: ${input.weekKey} (${input.startDate} – ${input.endDate}).`,
    "",
    "DZIENNIKI Z TEGO TYGODNIA:",
    journalsText,
    "",
    "OSTATNIE WPISY Z DZIENNIKA ZMIAN (wiki/log.md):",
    input.recentLogSection.slice(0, 3500) || "(brak)",
    "",
    "OTWARTE ZADANIA W WIKI:",
    tasksText,
    "",
    "AKTYWNE POMYSŁY (wiki/pomysly/):",
    ideasText,
    "",
    "ZASADY:",
    "1. Opieraj się WYŁĄCZNIE na powyższych danych — nie zmyślaj wydarzeń ani nie dodawaj fikcyjnych zadań.",
    "2. W `bodyMarkdown` NIE umieszczaj YAML frontmattera ani nagłówka H1 (`# ...`).",
    "3. Użyj dokładnie tych 4 sekcji H2 po polsku:",
    "   - `## Podsumowanie tygodnia` (2–4 zwięzłe zdania o tym, co się działo)",
    "   - `## Najważniejsze tematy i postępy` (punktowana lista z klikalnymi `[[wikilinks]]`)",
    "   - `## Priorytety i otwarte zadania na kolejny tydzień` (zwięzła lista najważniejszych `- [ ] ...` lub odnośników do obszarów)",
    "   - `## Pomysły i decyzje` (podsumowanie pomysłów z `wiki/pomysly/` i ważnych refleksji)",
    "",
    "Zwróć WYŁĄCZNIE poprawny obiekt JSON:",
    "{",
    '  "summary": "1-2 krótkie zdania pod e-ink (max 160 znaków)",',
    '  "bodyMarkdown": "## Podsumowanie tygodnia\\n..."',
    "}",
  ].join("\n");

  const { result: response } = await callGeminiWithFallback({
    logTag: "weeklyReviewAgent",
    perAttemptTimeoutMs: 30_000,
    runForModel: (model) =>
      ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0.25,
          responseMimeType: "application/json",
        },
      }),
  });

  const parsed = JSON.parse(stripCodeFences(response?.text ?? "{}")) as {
    summary?: unknown;
    bodyMarkdown?: unknown;
  };

  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 180)
      : `Podsumowanie tygodnia ${input.weekKey} (${input.startDate} – ${input.endDate}).`;

  const bodyMarkdown =
    typeof parsed.bodyMarkdown === "string" && parsed.bodyMarkdown.trim()
      ? parsed.bodyMarkdown
          .replace(/^---\n[\s\S]*?\n---\n*/m, "")
          .replace(/^\s*#\s+[^\n]+\n*/m, "")
          .trim()
      : [
          "## Podsumowanie tygodnia",
          summary,
          "",
          "## Najważniejsze tematy i postępy",
          "- Brak szczegółowych wpisów dziennych w tym zakresie.",
          "",
          "## Priorytety i otwarte zadania na kolejny tydzień",
          tasksText,
          "",
          "## Pomysły i decyzje",
          ideasText,
        ].join("\n");

  return { summary, bodyMarkdown };
}

export async function runWeeklyReviewAgent(params: {
  vaultClient: GitHubVaultClient;
  generateReview?: GenerateWeeklyReviewFn;
  vaultPrefix?: string;
  force?: boolean;
  now?: () => Date;
}): Promise<WeeklyReviewRunResult> {
  const nowDate = params.now ? params.now() : new Date();
  const nowIso = nowDate.toISOString().replace(/\.\d{3}Z$/, "Z");
  const dateStr = nowIso.slice(0, 10);
  const weekInfo = getIsoWeekInfo(nowDate);
  const reportRelPath = `wiki/dziennik/tydzien-${weekInfo.weekKey}.md`;
  const reportSlug = `dziennik/tydzien-${weekInfo.weekKey}`;
  const reportRepoPath = joinRepoPath(params.vaultPrefix, reportRelPath);
  const generateReview = params.generateReview ?? generateWeeklyReviewWithGemini;

  try {
    const indexRepoPath = joinRepoPath(params.vaultPrefix, "wiki/index.md");
    const logRepoPath = joinRepoPath(params.vaultPrefix, "wiki/log.md");

    const [treeEntries, indexMd, logMd] = await Promise.all([
      params.vaultClient.listTree(),
      params.vaultClient.fetchFile(indexRepoPath),
      params.vaultClient.fetchFile(logRepoPath),
    ]);

    const allWikiRelPaths = treeEntries
      .filter((entry) => entry.type === "blob" && /\.md$/i.test(entry.path))
      .map((entry) => extractVaultRelativePath(entry.path, params.vaultPrefix))
      .filter((rel): rel is string => Boolean(rel && rel.startsWith("wiki/")))
      .sort();

    if (allWikiRelPaths.includes(reportRelPath) && !params.force) {
      return {
        status: "skipped",
        weekKey: weekInfo.weekKey,
        reportPath: reportRelPath,
        summary: `Przegląd tygodniowy ${weekInfo.weekKey} już istnieje.`,
        journalDaysIncluded: 0,
        openTasksCount: 0,
        reason: "weekly_review_already_exists",
      };
    }

    const weekJournalPaths = allWikiRelPaths.filter((rel) => {
      const m = rel.match(/^wiki\/dziennik\/(\d{4}-\d{2}-\d{2})\.md$/);
      if (!m) return false;
      const d = m[1];
      return d >= weekInfo.startDate && d <= weekInfo.endDate;
    });

    const activeScanPaths = allWikiRelPaths
      .filter((rel) => {
        if (rel === "wiki/index.md" || rel === "wiki/log.md") return false;
        if (rel.startsWith("wiki/dziennik/")) return false;
        if (/\/research\.md$/i.test(rel)) return false;
        if (/^wiki\/projekty\/foxie-notes\/zadania\/etap-[12]-/i.test(rel)) {
          return false;
        }
        return true;
      })
      .slice(0, MAX_ACTIVE_SCAN_FILES);

    const [journalContents, activeContents] = await Promise.all([
      Promise.all(
        weekJournalPaths.map(async (rel) => {
          const content = await params.vaultClient.fetchFile(
            joinRepoPath(params.vaultPrefix, rel),
          );
          return content !== null ? { path: rel, content } : null;
        }),
      ),
      Promise.all(
        activeScanPaths.map(async (rel) => {
          const content = await params.vaultClient.fetchFile(
            joinRepoPath(params.vaultPrefix, rel),
          );
          return content !== null ? { path: rel, content } : null;
        }),
      ),
    ]);

    const journals = journalContents.filter(
      (item): item is { path: string; content: string } => item !== null,
    );
    const activeFiles = activeContents.filter(
      (item): item is { path: string; content: string } => item !== null,
    );

    const openTasks: Array<{ slug: string; text: string; dueDate?: string }> = [];
    const ideas: Array<{ slug: string; title: string; summary: string }> = [];

    for (const file of [...journals, ...activeFiles]) {
      const slug = file.path.replace(/^wiki\//i, "").replace(/\.md$/i, "");
      const tasks = extractTasksFromMarkdown({
        markdown: file.content,
        sourcePath: file.path,
        sourceSlug: slug,
        updatedAt: nowIso,
      });
      for (const task of tasks) {
        if (!task.completed) {
          openTasks.push({
            slug,
            text: task.text,
            ...(task.dueDate ? { dueDate: task.dueDate } : {}),
          });
        }
      }

      if (file.path.startsWith("wiki/pomysly/")) {
        const { frontmatter, body } = parseFrontmatter(file.content);
        const h1 = body.match(/^\s*#\s+(.+)$/m);
        ideas.push({
          slug,
          title: frontmatter.title || (h1 ? h1[1].trim() : slug),
          summary: frontmatter.summary || "",
        });
      }
    }

    const recentLogSection = (logMd ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/^---\n[\s\S]*?\n---\n*/m, "")
      .slice(0, 4000);

    const generated = await generateReview({
      weekKey: weekInfo.weekKey,
      startDate: weekInfo.startDate,
      endDate: weekInfo.endDate,
      journals,
      recentLogSection,
      openTasks,
      ideas,
    });

    const reportMarkdown = [
      "---",
      `title: ${JSON.stringify(`Przegląd tygodniowy ${weekInfo.weekKey}`)}`,
      `slug: ${reportSlug}`,
      `updated_at: ${nowIso}`,
      "tags: [dziennik, przeglad-tygodniowy]",
      `summary: ${JSON.stringify(generated.summary)}`,
      "---",
      "",
      `# Przegląd tygodniowy ${weekInfo.weekKey} (${weekInfo.startDate} – ${weekInfo.endDate})`,
      "",
      generated.summary,
      "",
      generated.bodyMarkdown,
      "",
    ].join("\n");

    const { markdown: nextIndexMd, changed: indexChanged } = updateWikiIndexMarkdown({
      existingIndexMarkdown: indexMd,
      slug: reportSlug,
      title: `Przegląd tygodniowy ${weekInfo.weekKey}`,
      description: generated.summary,
      section: "Dziennik",
      updatedAtIso: nowIso,
    });

    const nextLogMd = prependWeeklyReviewLogMarkdown({
      existingLogMarkdown: logMd,
      dateStr,
      updatedAtIso: nowIso,
      weekKey: weekInfo.weekKey,
      reportSlug,
      summary: generated.summary,
    });

    const changes: AtomicFileChange[] = [
      { path: reportRepoPath, content: reportMarkdown },
      ...(indexChanged ? [{ path: indexRepoPath, content: nextIndexMd }] : []),
      { path: logRepoPath, content: nextLogMd },
    ];

    const { commitSha } = await params.vaultClient.commitAtomicChanges({
      commitMessage: `agent(weekly-review): Przegląd tygodniowy ${weekInfo.weekKey}`,
      changes,
    });

    return {
      status: "created",
      weekKey: weekInfo.weekKey,
      reportPath: reportRelPath,
      summary: generated.summary,
      journalDaysIncluded: journals.length,
      openTasksCount: openTasks.length,
      commitSha,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "WeeklyReviewAgent execution failed";
    return {
      status: "error",
      weekKey: weekInfo.weekKey,
      reportPath: reportRelPath,
      summary: message,
      journalDaysIncluded: 0,
      openTasksCount: 0,
      reason: message,
    };
  }
}
