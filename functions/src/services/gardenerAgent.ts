import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { GardenerRunResult } from "../types/api.js";
import type { AtomicFileChange, GitHubVaultClient } from "./github.js";
import { updateWikiIndexMarkdown } from "./inboxOrganizer.js";
import {
  ensureCuratorFrontmatter,
  isProtectedVaultPath,
  sanitizeCuratorWikiPath,
  sectionFromWikiRelativePath,
} from "./vaultCommandAgent.js";
import { parseFrontmatter } from "./wikiParser.js";
import { extractVaultRelativePath } from "./wikiSync.js";

const DEFAULT_MODEL = "gemini-3.8-flash";
const MAX_FETCHED_WIKI_PAGES = 25;
const MAX_LLM_CONTEXT_PAGES = 20;

export interface GardenerWriteOp {
  path: string;
  title: string;
  description: string;
  contentMarkdown: string;
}

export interface GardenerPlan {
  summary: string;
  writes: GardenerWriteOp[];
}

export type BuildGardenerPlanFn = (input: {
  noteDate: string;
  schemaMarkdown: string;
  wikiIndexMarkdown: string;
  existingWikiPaths: string[];
  pages: Array<{ path: string; content: string }>;
}) => Promise<GardenerPlan>;

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

function isIndexableWikiRelPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm.startsWith("wiki/") || !/\.md$/i.test(norm)) return false;
  if (norm === "wiki/index.md" || norm === "wiki/log.md") return false;
  if (/\/research\.md$/i.test(norm)) return false;
  return true;
}

function isEditableByGardener(relPath: string): boolean {
  if (isProtectedVaultPath(relPath)) return false;
  if (/\/research\.md$/i.test(relPath)) return false;
  if (/^wiki\/dziennik\/tydzien-/i.test(relPath)) return false;
  return true;
}

export function auditAndRepairWikiIndex(params: {
  indexMarkdown: string | null;
  allWikiRelPaths: string[];
  pageMetaByRelPath: Map<string, { title: string; summary: string }>;
  updatedAtIso: string;
}): {
  markdown: string;
  added: string[];
  removed: string[];
  changed: boolean;
} {
  const indexablePaths = params.allWikiRelPaths
    .filter(isIndexableWikiRelPath)
    .sort();
  const existingRelSet = new Set(
    params.allWikiRelPaths.map((p) => p.replace(/\\/g, "/").toLowerCase()),
  );

  let currentMd = (
    params.indexMarkdown?.trim() ||
    [
      "---",
      "title: Spis treści",
      "slug: index",
      `updated_at: ${params.updatedAtIso}`,
      "tags: [index]",
      "---",
      "",
      "# Spis treści Vaulta",
      "",
      "## System",
      "- [[log|Dziennik zmian (log)]]",
      "",
    ].join("\n")
  ).replace(/\r\n/g, "\n");

  const removed: string[] = [];
  const lines = currentMd.split("\n");
  const filteredLines: string[] = [];

  for (const line of lines) {
    const bulletLink = line.match(/^\s*[-*]\s+.*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/);
    if (bulletLink) {
      const slug = bulletLink[1].trim().replace(/^\/+/, "").replace(/\.md$/i, "");
      if (slug && slug.toLowerCase() !== "log") {
        const expectedRel = `wiki/${slug}.md`.toLowerCase();
        if (!existingRelSet.has(expectedRel)) {
          removed.push(slug);
          continue;
        }
      }
    }
    filteredLines.push(line);
  }

  let changed = removed.length > 0;
  currentMd = `${filteredLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;

  if (removed.length > 0) {
    if (/^updated_at\s*:/m.test(currentMd)) {
      currentMd = currentMd.replace(
        /^updated_at\s*:.*$/m,
        `updated_at: ${params.updatedAtIso}`,
      );
    }
  }

  const added: string[] = [];
  for (const relPath of indexablePaths) {
    const slug = relPath.replace(/^wiki\//i, "").replace(/\.md$/i, "");
    const meta = params.pageMetaByRelPath.get(relPath);
    const title = meta?.title || path.posix.basename(relPath, ".md");
    const description = meta?.summary || title;
    const res = updateWikiIndexMarkdown({
      existingIndexMarkdown: currentMd,
      slug,
      title,
      description,
      section: sectionFromWikiRelativePath(relPath),
      updatedAtIso: params.updatedAtIso,
    });
    if (res.changed) {
      currentMd = res.markdown;
      added.push(slug);
      changed = true;
    }
  }

  return {
    markdown: currentMd,
    added,
    removed,
    changed,
  };
}

export function prependGardenerLogMarkdown(params: {
  existingLogMarkdown: string | null;
  dateStr: string;
  updatedAtIso: string;
  summary: string;
  indexAdded: string[];
  indexRemoved: string[];
  filesUpdated: string[];
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

  const details: string[] = [];
  if (params.indexAdded.length > 0) {
    details.push(`dodano do indeksu: ${params.indexAdded.map((s) => `[[${s}]]`).join(", ")}`);
  }
  if (params.indexRemoved.length > 0) {
    details.push(`usunięto martwe wpisy: ${params.indexRemoved.join(", ")}`);
  }
  if (params.filesUpdated.length > 0) {
    details.push(
      `zaktualizowano: ${params.filesUpdated
        .map((p) => `[[${p.replace(/^wiki\//i, "").replace(/\.md$/i, "")}]]`)
        .join(", ")}`,
    );
  }

  const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
  const line = `- **Agent Ogrodnik (\`gardener\`):** ${params.summary}${suffix}.`;
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

export async function buildGardenerPlanWithGemini(input: {
  noteDate: string;
  schemaMarkdown: string;
  wikiIndexMarkdown: string;
  existingWikiPaths: string[];
  pages: Array<{ path: string; content: string }>;
}): Promise<GardenerPlan> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY for GardenerAgent");
  }

  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const ai = new GoogleGenAI({ apiKey });

  const pagesContext = input.pages
    .slice(0, MAX_LLM_CONTEXT_PAGES)
    .map(
      (page) =>
        `=== PLIK: ${page.path} ===\n${page.content.slice(0, 3000)}\n=== KONIEC PLIKU ===`,
    )
    .join("\n\n");

  const prompt = [
    "Jesteś cyklicznym Agentem Ogrodnikiem prywatnego vaulta Obsidian (Foxie Notes).",
    `Dzisiejsza data: ${input.noteDate}.`,
    "",
    "Twoim zadaniem jest wyłącznie delikatna, bezpieczna pielęgnacja istniejących stron wiki:",
    "- Dodaj brakujące powiązania `[[wikilinks]]` (np. w linii `Powiązane:`), jeśli dwie strony wyraźnie dotyczą pokrewnego tematu.",
    "- Usuń dokładne duplikaty linii zadań `- [ ] ...` w obrębie tej samej strony lub napraw wyraźnie zepsuty `[[slug]]` (korzystając z listy istniejących ścieżek).",
    "- Jeśli strony są już czyste i spójne, ZWRÓĆ PUSTĄ TABLICĘ `writes: []`.",
    "",
    "ZASADY BEZWZGLĘDNE:",
    "1. NIGDY nie wymyślaj nowych faktów, zadań ani dat; nie usuwaj merytorycznych treści ani sekcji `## Źródła` / `## Synchronizacja Google`.",
    "2. Modyfikuj WYŁĄCZNIE istniejące edytowalne ścieżki z sekcji poniżej — NIGDY nie twórz nowych plików, nie zmieniaj `wiki/index.md`, `wiki/log.md`, `SCHEMA.md`, `wiki/projekty/foxie-notes/**`, `**/research.md` ani `wiki/dziennik/tydzien-*`.",
    "3. Jeśli modyfikujesz stronę, zwróć jej kompletną, poprawioną treść w `contentMarkdown` wraz z YAML frontmatterem.",
    "",
    "SCHEMA.md:",
    input.schemaMarkdown.slice(0, 2500) || "(brak)",
    "",
    "Aktualny wiki/index.md:",
    input.wikiIndexMarkdown.slice(0, 3500) || "(pusty)",
    "",
    "Wszystkie istniejące ścieżki wiki/:",
    input.existingWikiPaths.join("\n") || "(brak)",
    "",
    "Edytowalne strony wiki/ do przeglądu:",
    pagesContext || "(brak)",
    "",
    "Zwróć WYŁĄCZNIE poprawny obiekt JSON:",
    "{",
    '  "summary": "Krótkie podsumowanie pielęgnacji po polsku (max 140 znaków)",',
    '  "writes": [',
    "    {",
    '      "path": "wiki/...",',
    '      "title": "Tytuł strony",',
    '      "description": "Krótki opis do indeksu",',
    '      "contentMarkdown": "---\\ntitle: ...\\n---\\n\\n# ..."',
    "    }",
    "  ]",
    "}",
  ].join("\n");

  let response: Awaited<ReturnType<typeof ai.models.generateContent>> | undefined;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0.15,
          responseMimeType: "application/json",
        },
      });
      break;
    } catch (err) {
      if (attempt < maxAttempts && isTransientGeminiError(err)) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        continue;
      }
      throw err;
    }
  }

  const parsed = JSON.parse(stripJsonFences(response?.text ?? "{}")) as {
    summary?: unknown;
    writes?: unknown;
  };

  const writes: GardenerWriteOp[] = [];
  if (Array.isArray(parsed.writes)) {
    for (const item of parsed.writes) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (
        typeof obj.path === "string" &&
        typeof obj.contentMarkdown === "string" &&
        obj.contentMarkdown.trim()
      ) {
        writes.push({
          path: obj.path.trim(),
          title:
            typeof obj.title === "string" && obj.title.trim()
              ? obj.title.trim()
              : path.posix.basename(obj.path.trim(), ".md"),
          description:
            typeof obj.description === "string" && obj.description.trim()
              ? obj.description.trim()
              : "Strona wypielęgnowana przez Agenta Ogrodnika.",
          contentMarkdown: obj.contentMarkdown,
        });
      }
    }
  }

  return {
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : "Przejrzano i uporządkowano powiązania w wiki.",
    writes,
  };
}

export async function runGardenerAgent(params: {
  vaultClient: GitHubVaultClient;
  buildPlan?: BuildGardenerPlanFn;
  vaultPrefix?: string;
  skipLlm?: boolean;
  now?: () => Date;
}): Promise<GardenerRunResult> {
  const nowDate = params.now ? params.now() : new Date();
  const nowIso = nowDate.toISOString().replace(/\.\d{3}Z$/, "Z");
  const noteDate = nowIso.slice(0, 10);
  const buildPlan = params.buildPlan ?? buildGardenerPlanWithGemini;

  try {
    const schemaRepoPath = joinRepoPath(params.vaultPrefix, "SCHEMA.md");
    const indexRepoPath = joinRepoPath(params.vaultPrefix, "wiki/index.md");
    const logRepoPath = joinRepoPath(params.vaultPrefix, "wiki/log.md");

    const [treeEntries, schemaMd, indexMd, logMd] = await Promise.all([
      params.vaultClient.listTree(),
      params.vaultClient.fetchFile(schemaRepoPath),
      params.vaultClient.fetchFile(indexRepoPath),
      params.vaultClient.fetchFile(logRepoPath),
    ]);

    const allWikiRelPaths = treeEntries
      .filter((entry) => entry.type === "blob" && /\.md$/i.test(entry.path))
      .map((entry) => extractVaultRelativePath(entry.path, params.vaultPrefix))
      .filter((rel): rel is string => Boolean(rel && rel.startsWith("wiki/")))
      .sort();

    const existingWikiSet = new Set(allWikiRelPaths);
    const indexTextLower = (indexMd ?? "").toLowerCase();
    const indexablePaths = allWikiRelPaths.filter(isIndexableWikiRelPath);

    // Prioritize pages missing from wiki/index.md first, then editable pages
    const missingFromIndex = indexablePaths.filter((rel) => {
      const slug = rel.replace(/^wiki\//i, "").replace(/\.md$/i, "").toLowerCase();
      return !indexTextLower.includes(`[[${slug}|`) && !indexTextLower.includes(`[[${slug}]]`);
    });
    const editablePaths = allWikiRelPaths.filter(isEditableByGardener);
    const pathsToFetch = Array.from(
      new Set([...missingFromIndex, ...editablePaths]),
    ).slice(0, MAX_FETCHED_WIKI_PAGES);

    const fetchedContentByRel = new Map<string, string>();
    const pageMetaByRelPath = new Map<string, { title: string; summary: string }>();

    await Promise.all(
      pathsToFetch.map(async (rel) => {
        const content = await params.vaultClient.fetchFile(
          joinRepoPath(params.vaultPrefix, rel),
        );
        if (content !== null) {
          fetchedContentByRel.set(rel, content);
          const { frontmatter, body } = parseFrontmatter(content);
          const h1 = body.match(/^\s*#\s+(.+)$/m);
          pageMetaByRelPath.set(rel, {
            title:
              frontmatter.title ||
              (h1 ? h1[1].trim() : "") ||
              path.posix.basename(rel, ".md"),
            summary: frontmatter.summary || "",
          });
        }
      }),
    );

    const indexAudit = auditAndRepairWikiIndex({
      indexMarkdown: indexMd,
      allWikiRelPaths,
      pageMetaByRelPath,
      updatedAtIso: nowIso,
    });

    const editableContextPages = editablePaths
      .filter((rel) => fetchedContentByRel.has(rel))
      .slice(0, MAX_LLM_CONTEXT_PAGES)
      .map((rel) => ({
        path: rel,
        content: fetchedContentByRel.get(rel)!,
      }));

    let llmPlan: GardenerPlan = {
      summary: "Sprawdzono spójność spisu treści.",
      writes: [],
    };
    if (!params.skipLlm && editableContextPages.length > 0) {
      try {
        llmPlan = await buildPlan({
          noteDate,
          schemaMarkdown: schemaMd ?? "",
          wikiIndexMarkdown: indexAudit.markdown,
          existingWikiPaths: allWikiRelPaths,
          pages: editableContextPages,
        });
      } catch (planErr) {
        if (isTransientGeminiError(planErr) && indexAudit.changed) {
          console.warn(
            "[gardenerAgent] Gemini transient error; applying deterministic wiki/index.md repair only",
          );
        } else {
          throw planErr;
        }
      }
    }

    const safeWrites: GardenerWriteOp[] = [];
    const seenWritePaths = new Set<string>();
    for (const write of llmPlan.writes) {
      const safePath = sanitizeCuratorWikiPath(write.path, params.vaultPrefix);
      if (!safePath || seenWritePaths.has(safePath)) continue;
      if (!existingWikiSet.has(safePath) || !isEditableByGardener(safePath)) {
        continue;
      }

      const normalizedNext = ensureCuratorFrontmatter({
        contentMarkdown: write.contentMarkdown,
        targetPath: safePath,
        title: write.title,
        nowIso,
        noteDate,
      });

      const prevContent = (fetchedContentByRel.get(safePath) ?? "").replace(/\r\n/g, "\n");
      const prevComparable = prevContent.replace(/^updated_at:.*$/m, "").trim();
      const nextComparable = normalizedNext.replace(/^updated_at:.*$/m, "").trim();
      if (prevComparable === nextComparable) {
        continue;
      }

      seenWritePaths.add(safePath);
      safeWrites.push({
        ...write,
        path: safePath,
        contentMarkdown: normalizedNext,
      });
    }

    if (!indexAudit.changed && safeWrites.length === 0) {
      return {
        status: "skipped",
        summary: "Vault jest spójny — brak zmian do wprowadzenia.",
        indexAdded: [],
        indexRemoved: [],
        filesUpdated: [],
        reason: "vault_already_clean",
      };
    }

    const changes: AtomicFileChange[] = [];
    for (const write of safeWrites) {
      changes.push({
        path: joinRepoPath(params.vaultPrefix, write.path),
        content: write.contentMarkdown,
      });
    }

    if (indexAudit.changed) {
      changes.push({
        path: indexRepoPath,
        content: indexAudit.markdown,
      });
    }

    const filesUpdated = safeWrites.map((w) => w.path);
    const summaryText =
      indexAudit.changed && safeWrites.length === 0
        ? `Uporządkowano spis treści wiki/index.md (dodano: ${indexAudit.added.length}, usunięto martwych: ${indexAudit.removed.length})`
        : llmPlan.summary;

    const nextLogMd = prependGardenerLogMarkdown({
      existingLogMarkdown: logMd,
      dateStr: noteDate,
      updatedAtIso: nowIso,
      summary: summaryText,
      indexAdded: indexAudit.added,
      indexRemoved: indexAudit.removed,
      filesUpdated,
    });
    changes.push({
      path: logRepoPath,
      content: nextLogMd,
    });

    const commitSummary = summaryText.replace(/\s+/g, " ").trim().slice(0, 72);
    const { commitSha } = await params.vaultClient.commitAtomicChanges({
      commitMessage: `agent(gardener): ${commitSummary || "tidy wiki"}`,
      changes,
    });

    return {
      status: "executed",
      summary: summaryText,
      indexAdded: indexAudit.added,
      indexRemoved: indexAudit.removed,
      filesUpdated,
      commitSha,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "GardenerAgent execution failed";
    return {
      status: "error",
      summary: message,
      indexAdded: [],
      indexRemoved: [],
      filesUpdated: [],
      reason: message,
    };
  }
}
