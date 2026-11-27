import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { VaultCommandRunResult } from "../types/api.js";
import type { AtomicFileChange, GitHubVaultClient } from "./github.js";
import {
  type IndexSectionName,
  updateWikiIndexMarkdown,
} from "./inboxOrganizer.js";
import { slugifyPolish } from "./markdown.js";
import { parseFrontmatter } from "./wikiParser.js";
import { extractVaultRelativePath } from "./wikiSync.js";

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_SELECTED_FILES = 10;
const ALLOWED_TOP_FOLDERS = new Set([
  "projekty",
  "obszary",
  "pomysly",
  "zasoby",
  "dziennik",
]);

export interface SelectRelevantFilesInput {
  command: string;
  wikiIndexMarkdown: string;
  availablePaths: string[];
  noteDate: string;
}

export type SelectRelevantFilesFn = (
  input: SelectRelevantFilesInput,
) => Promise<string[]>;

export interface VaultCommandPlanWrite {
  path: string;
  title: string;
  description: string;
  contentMarkdown: string;
}

export interface VaultCommandPlan {
  summary: string;
  writes: VaultCommandPlanWrite[];
  deletes: string[];
}

export interface BuildVaultCommandPlanInput {
  command: string;
  noteDate: string;
  schemaMarkdown: string;
  wikiIndexMarkdown: string;
  existingWikiPaths: string[];
  contextFiles: Array<{ path: string; content: string }>;
}

export type BuildVaultCommandPlanFn = (
  input: BuildVaultCommandPlanInput,
) => Promise<VaultCommandPlan>;

function joinRepoPath(prefix: string | undefined, relativePath: string): string {
  const cleanPrefix = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  const cleanRel = relativePath.replace(/^\/+/, "");
  return cleanPrefix ? `${cleanPrefix}/${cleanRel}` : cleanRel;
}

export function isProtectedVaultPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  if (
    norm === "wiki/index.md" ||
    norm === "wiki/log.md" ||
    norm === "schema.md" ||
    norm.startsWith("raw/") ||
    norm === "wiki/projekty/foxie-notes.md" ||
    norm.startsWith("wiki/projekty/foxie-notes/")
  ) {
    return true;
  }
  return false;
}

/**
 * Sanitizes and validates a target Markdown path for the Curator agent.
 * Only PARA + Dziennik paths under `wiki/` are allowed; protected system/project paths return null.
 */
export function sanitizeCuratorWikiPath(
  rawPath: string,
  vaultPrefix?: string,
): string | null {
  const extracted = extractVaultRelativePath(rawPath.trim(), vaultPrefix);
  let normalized = (extracted ?? rawPath)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

  if (normalized.toLowerCase().startsWith("vault/")) {
    normalized = normalized.slice("vault/".length);
  }
  if (!normalized || normalized.includes("..")) {
    return null;
  }
  if (isProtectedVaultPath(normalized)) {
    return null;
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0].toLowerCase() !== "wiki") {
    return null;
  }

  const sectionFolder = segments[1].toLowerCase();
  if (!ALLOWED_TOP_FOLDERS.has(sectionFolder)) {
    return null;
  }

  if (sectionFolder === "projekty" && segments[2].toLowerCase().replace(/\.md$/i, "") === "foxie-notes") {
    return null;
  }

  const cleanSubSegments: string[] = [];
  for (let i = 2; i < segments.length; i++) {
    const isLast = i === segments.length - 1;
    const rawSeg = isLast ? segments[i].replace(/\.md$/i, "") : segments[i];
    const slugSeg = slugifyPolish(rawSeg);
    if (!slugSeg || slugSeg.startsWith(".")) {
      return null;
    }
    cleanSubSegments.push(isLast ? `${slugSeg}.md` : slugSeg);
  }

  const result = `wiki/${sectionFolder}/${cleanSubSegments.join("/")}`;
  return isProtectedVaultPath(result) ? null : result;
}

export function sectionFromWikiRelativePath(relPath: string): IndexSectionName {
  const lower = relPath.toLowerCase();
  if (lower.startsWith("wiki/projekty/")) return "Projekty";
  if (lower.startsWith("wiki/obszary/")) return "Obszary";
  if (lower.startsWith("wiki/pomysly/")) return "Pomysły";
  if (lower.startsWith("wiki/zasoby/")) return "Zasoby";
  return "Dziennik";
}

function defaultTypeForSection(section: IndexSectionName): string {
  switch (section) {
    case "Projekty":
      return "project";
    case "Obszary":
      return "area";
    case "Pomysły":
      return "idea";
    case "Zasoby":
      return "resource";
    case "Dziennik":
      return "journal";
  }
}

export function ensureCuratorFrontmatter(params: {
  contentMarkdown: string;
  targetPath: string;
  title: string;
  nowIso: string;
  noteDate: string;
}): string {
  const normalized = params.contentMarkdown.replace(/\r\n/g, "\n").trim();
  const section = sectionFromWikiRelativePath(params.targetPath);
  const { frontmatter } = parseFrontmatter(normalized);
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/);

  if (!fmMatch) {
    const safeTitle = (params.title || frontmatter.title || path.basename(params.targetPath, ".md"))
      .replace(/"/g, '\\"');
    const header = [
      "---",
      `title: "${safeTitle}"`,
      `type: ${defaultTypeForSection(section)}`,
      "status: active",
      "tags: []",
      `created_at: ${params.noteDate}`,
      `updated_at: ${params.nowIso}`,
      'source: "agent(curator)"',
      "---",
    ].join("\n");
    return `${header}\n\n${normalized}\n`;
  }

  let yamlBlock = fmMatch[1];
  const body = (fmMatch[2] ?? "").replace(/^\n+/, "");

  if (/^updated_at:/m.test(yamlBlock)) {
    yamlBlock = yamlBlock.replace(/^updated_at:.*$/m, `updated_at: ${params.nowIso}`);
  } else {
    yamlBlock = `${yamlBlock}\nupdated_at: ${params.nowIso}`;
  }

  if (!/^title:/m.test(yamlBlock) && params.title.trim()) {
    const safeTitle = params.title.trim().replace(/"/g, '\\"');
    yamlBlock = `title: "${safeTitle}"\n${yamlBlock}`;
  }

  return `---\n${yamlBlock}\n---\n\n${body}${body.endsWith("\n") ? "" : "\n"}`;
}

export function prependCuratorLogMarkdown(params: {
  existingLogMarkdown: string | null;
  dateStr: string;
  updatedAtIso: string;
  summary: string;
  writtenSlugs: string[];
}): string {
  const base = (
    params.existingLogMarkdown ??
    `---
title: Log zmian
type: index
updated_at: ${params.updatedAtIso}
---

# Log zmian
`
  ).replace(/\r\n/g, "\n");

  const withTimestamp = base.replace(
    /^updated_at:\s*.*$/m,
    `updated_at: ${params.updatedAtIso}`,
  );

  const linkList =
    params.writtenSlugs.length > 0
      ? params.writtenSlugs.map((slug) => `[[${slug}]]`).join(", ")
      : "brak nowych stron";
  const line = `- **Agent Kurator (\`vault-command\`):** ${params.summary} (${linkList})`;
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

function removeDeletedSlugsFromIndex(
  indexMarkdown: string,
  deletedSlugs: string[],
): { markdown: string; changed: boolean } {
  if (deletedSlugs.length === 0) {
    return { markdown: indexMarkdown, changed: false };
  }
  const lines = indexMarkdown.replace(/\r\n/g, "\n").split("\n");
  const slugMarkers = deletedSlugs.map((slug) => `[[${slug}`);
  const filtered = lines.filter(
    (line) => !slugMarkers.some((marker) => line.includes(marker)),
  );
  const changed = filtered.length !== lines.length;
  return {
    markdown: filtered.join("\n"),
    changed,
  };
}

function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

export async function selectRelevantFilesWithGemini(
  input: SelectRelevantFilesInput,
): Promise<string[]> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY for VaultCommandAgent");
  }

  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const ai = new GoogleGenAI({ apiKey });
  const cappedPaths = input.availablePaths.slice(0, 150);
  const prompt = [
    "Jesteś Agentem Kuratorem bazy wiedzy Obsidian (Foxie Notes).",
    `Dzisiejsza data: ${input.noteDate}.`,
    "",
    "Użytkownik wydał polecenie reorganizacji lub porządkowania repozytorium Obsidian:",
    `POLECENIE: ${input.command}`,
    "",
    "Spis treści wiki/index.md:",
    input.wikiIndexMarkdown || "(pusty)",
    "",
    "Dostępne pliki w repozytorium:",
    cappedPaths.map((p) => `- ${p}`).join("\n") || "(brak)",
    "",
    `Wybierz maksymalnie ${MAX_SELECTED_FILES} najbardziej powiązanych ścieżek z powyższej listy (zarówno stron wiki/, jak i raw/processed/), które należy przeczytać, aby rzetelnie wykonać polecenie użytkownika (np. znaleźć notatki o danym temacie lub docelowy plik).`,
    'Zwróć WYŁĄCZNIE poprawny obiekt JSON: { "paths": ["..."] }',
  ].join("\n");

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  });

  const parsed = JSON.parse(stripJsonFences(response.text ?? "{}")) as {
    paths?: unknown;
  };
  if (!Array.isArray(parsed.paths)) {
    return [];
  }
  const availableSet = new Set(input.availablePaths);
  const picked: string[] = [];
  for (const item of parsed.paths) {
    if (typeof item === "string" && availableSet.has(item) && !picked.includes(item)) {
      picked.push(item);
      if (picked.length >= MAX_SELECTED_FILES) break;
    }
  }
  return picked;
}

export async function buildVaultCommandPlanWithGemini(
  input: BuildVaultCommandPlanInput,
): Promise<VaultCommandPlan> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY for VaultCommandAgent");
  }

  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const ai = new GoogleGenAI({ apiKey });
  const filesContext =
    input.contextFiles.length > 0
      ? input.contextFiles
          .map(
            (file) =>
              `=== PLIK: ${file.path} ===\n${file.content.slice(0, 6000)}\n=== KONIEC PLIKU ===`,
          )
          .join("\n\n")
      : "(brak dopasowanych plików źródłowych)";

  const prompt = [
    "Jesteś Agentem Kuratorem repozytorium Obsidian (metodologia PARA + Dziennik).",
    `Dzisiejsza data: ${input.noteDate}.`,
    "",
    "POLECENIE UŻYTKOWNIKA:",
    input.command,
    "",
    "SCHEMA.md:",
    input.schemaMarkdown.slice(0, 3500) || "(brak)",
    "",
    "Aktualny wiki/index.md:",
    input.wikiIndexMarkdown.slice(0, 3500) || "(pusty)",
    "",
    "Istniejące ścieżki wiki/:",
    input.existingWikiPaths.join("\n") || "(brak)",
    "",
    "Zawartość wybranych plików kontekstowych:",
    filesContext,
    "",
    "ZASADY BEZWZGLĘDNE:",
    "1. Dozwolone są wyłącznie ścieżki pod `wiki/projekty/`, `wiki/obszary/`, `wiki/pomysly/`, `wiki/zasoby/` lub `wiki/dziennik/` (w tym podfoldery tematyczne, np. `wiki/obszary/zdrowie/samopoczucie.md`). Nazwy folderów i plików bez polskich znaków, małe litery, myślniki, zakończone `.md`.",
    "2. NIGDY nie umieszczaj w `writes` ani `deletes` plików chronionych: `wiki/index.md`, `wiki/log.md`, `SCHEMA.md`, `raw/**`, ani niczego pod `wiki/projekty/foxie-notes/**`. (`wiki/index.md` i `wiki/log.md` zostaną zaktualizowane automatycznie po Twoich zmianach).",
    "3. Jeśli tworzysz nową stronę tematyczną z notatek rozsianych w dzienniku lub w `raw/processed/`, przenieś lub skopiuj do niej pełne fakty, daty, źródła (`raw/processed/...`) oraz powiązania `[[...]]` — NIE zmyślaj faktów, których nie ma w plikach.",
    "4. Jeśli modyfikujesz istniejący plik (np. dziennik `wiki/dziennik/...`), zachowaj pozostałe sekcje tego pliku nienaruszone (w tym ewentualną sekcję `## Synchronizacja Google`) — możesz zostawić w dzienniku zwięzły odnośnik `[[obszary/...]]` albo usunąć zduplikowaną sekcję zgodnie z prośbą użytkownika.",
    "5. Każdy wpis w `writes` musi zawierać kompletny dokument Markdown z YAML frontmatterem (`title`, `type`, `status`, `tags`, `created_at`, `updated_at`, `source`).",
    "6. `deletes` używaj tylko wtedy, gdy stary plik wiki jest całkowicie pusty po przeniesieniu lub użytkownik wyraźnie prosił o usunięcie/przeniesienie.",
    "",
    "Zwróć WYŁĄCZNIE poprawny obiekt JSON:",
    "{",
    '  "summary": "Krótkie podsumowanie po polsku (max 140 znaków)",',
    '  "writes": [',
    "    {",
    '      "path": "wiki/obszary/zdrowie/samopoczucie.md",',
    '      "title": "Zdrowie i samopoczucie",',
    '      "description": "Jedno zdanie do wiki/index.md",',
    '      "contentMarkdown": "---\\ntitle: ...\\n---\\n\\n# ..."',
    "    }",
    "  ],",
    '  "deletes": []',
    "}",
  ].join("\n");

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
  });

  const parsed = JSON.parse(stripJsonFences(response.text ?? "{}")) as {
    summary?: unknown;
    writes?: unknown;
    deletes?: unknown;
  };

  const writes: VaultCommandPlanWrite[] = [];
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
              : path.basename(obj.path.trim(), ".md"),
          description:
            typeof obj.description === "string" && obj.description.trim()
              ? obj.description.trim()
              : "Strona uporządkowana przez Kuratora Wiki.",
          contentMarkdown: obj.contentMarkdown,
        });
      }
    }
  }

  const deletes = Array.isArray(parsed.deletes)
    ? parsed.deletes.filter((d): d is string => typeof d === "string" && Boolean(d.trim()))
    : [];

  return {
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : "Uporządkowano strukturę wiki.",
    writes,
    deletes,
  };
}

export async function runVaultCommandAgent(params: {
  command: string;
  vaultClient: GitHubVaultClient;
  selectFiles?: SelectRelevantFilesFn;
  buildPlan?: BuildVaultCommandPlanFn;
  vaultPrefix?: string;
  extraChanges?: AtomicFileChange[];
  now?: () => Date;
}): Promise<VaultCommandRunResult> {
  const command = params.command.trim();
  if (!command) {
    return {
      status: "skipped",
      summary: "Puste polecenie dla Kuratora Wiki.",
      filesWritten: [],
      filesDeleted: [],
      reason: "empty_command",
    };
  }

  const nowDate = params.now ? params.now() : new Date();
  const nowIso = nowDate.toISOString();
  const noteDate = nowIso.slice(0, 10);

  const selectFiles = params.selectFiles ?? selectRelevantFilesWithGemini;
  const buildPlan = params.buildPlan ?? buildVaultCommandPlanWithGemini;

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

    const allRelMdPaths = treeEntries
      .filter((entry) => entry.type === "blob" && /\.md$/i.test(entry.path))
      .map((entry) => extractVaultRelativePath(entry.path, params.vaultPrefix))
      .filter((rel): rel is string => Boolean(rel));

    const existingWikiPaths = allRelMdPaths
      .filter((rel) => rel.startsWith("wiki/"))
      .sort();

    const editableWikiPaths = existingWikiPaths.filter(
      (rel) => !isProtectedVaultPath(rel),
    );
    const processedPaths = allRelMdPaths
      .filter((rel) => rel.startsWith("raw/processed/"))
      .sort()
      .reverse();

    const availablePaths = [...editableWikiPaths, ...processedPaths];

    const selectedRelPaths = await selectFiles({
      command,
      wikiIndexMarkdown: indexMd ?? "",
      availablePaths,
      noteDate,
    });

    const uniqueSelected = Array.from(
      new Set(
        selectedRelPaths
          .map((p) => extractVaultRelativePath(p, params.vaultPrefix) ?? p.trim())
          .filter((rel) => availablePaths.includes(rel)),
      ),
    ).slice(0, MAX_SELECTED_FILES);

    const fetched = await Promise.all(
      uniqueSelected.map(async (rel) => {
        const content = await params.vaultClient.fetchFile(
          joinRepoPath(params.vaultPrefix, rel),
        );
        return content !== null ? { path: rel, content } : null;
      }),
    );
    const contextFiles = fetched.filter(
      (item): item is { path: string; content: string } => item !== null,
    );

    const plan = await buildPlan({
      command,
      noteDate,
      schemaMarkdown: schemaMd ?? "",
      wikiIndexMarkdown: indexMd ?? "",
      existingWikiPaths,
      contextFiles,
    });

    const existingSet = new Set(existingWikiPaths);
    const safeWritesMap = new Map<string, VaultCommandPlanWrite>();
    for (const write of plan.writes) {
      const safePath = sanitizeCuratorWikiPath(write.path, params.vaultPrefix);
      if (!safePath) continue;
      safeWritesMap.set(safePath, { ...write, path: safePath });
    }

    const safeDeletes: string[] = [];
    for (const delPath of plan.deletes) {
      const safePath = sanitizeCuratorWikiPath(delPath, params.vaultPrefix);
      if (
        safePath &&
        !safeWritesMap.has(safePath) &&
        existingSet.has(safePath) &&
        !safeDeletes.includes(safePath)
      ) {
        safeDeletes.push(safePath);
      }
    }

    const safeWrites = Array.from(safeWritesMap.values());
    if (safeWrites.length === 0 && safeDeletes.length === 0) {
      return {
        status: "skipped",
        summary: plan.summary || "Brak bezpiecznych zmian do zastosowania.",
        filesWritten: [],
        filesDeleted: [],
        reason: "no_valid_changes",
      };
    }

    const changes: AtomicFileChange[] = [];
    let currentIndexMd = indexMd ?? "";
    let indexChanged = false;
    const writtenSlugs: string[] = [];

    for (const write of safeWrites) {
      const finalMarkdown = ensureCuratorFrontmatter({
        contentMarkdown: write.contentMarkdown,
        targetPath: write.path,
        title: write.title,
        nowIso,
        noteDate,
      });
      changes.push({
        path: joinRepoPath(params.vaultPrefix, write.path),
        content: finalMarkdown,
      });

      const slug = write.path.replace(/^wiki\//i, "").replace(/\.md$/i, "");
      writtenSlugs.push(slug);
      const updatedIdx = updateWikiIndexMarkdown({
        existingIndexMarkdown: currentIndexMd || null,
        slug,
        title: write.title,
        description: write.description,
        section: sectionFromWikiRelativePath(write.path),
        updatedAtIso: nowIso,
      });
      currentIndexMd = updatedIdx.markdown;
      if (updatedIdx.changed) {
        indexChanged = true;
      }
    }

    const deletedSlugs: string[] = [];
    for (const delRelPath of safeDeletes) {
      changes.push({
        path: joinRepoPath(params.vaultPrefix, delRelPath),
        content: null,
      });
      deletedSlugs.push(delRelPath.replace(/^wiki\//i, "").replace(/\.md$/i, ""));
    }

    const prunedIdx = removeDeletedSlugsFromIndex(currentIndexMd, deletedSlugs);
    currentIndexMd = prunedIdx.markdown;
    if (prunedIdx.changed) {
      indexChanged = true;
    }

    if (indexChanged) {
      changes.push({
        path: indexRepoPath,
        content: currentIndexMd,
      });
    }

    const nextLogMd = prependCuratorLogMarkdown({
      existingLogMarkdown: logMd,
      dateStr: noteDate,
      updatedAtIso: nowIso,
      summary: plan.summary,
      writtenSlugs,
    });
    changes.push({
      path: logRepoPath,
      content: nextLogMd,
    });

    if (params.extraChanges && params.extraChanges.length > 0) {
      changes.push(...params.extraChanges);
    }

    const commitSummary = plan.summary.replace(/\s+/g, " ").trim().slice(0, 72);
    const { commitSha } = await params.vaultClient.commitAtomicChanges({
      commitMessage: `agent(curator): ${commitSummary || "reorganize wiki"}`,
      changes,
    });

    return {
      status: "executed",
      summary: plan.summary,
      filesWritten: safeWrites.map((w) => w.path),
      filesDeleted: safeDeletes,
      commitSha,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "VaultCommandAgent execution failed";
    return {
      status: "error",
      summary: message,
      filesWritten: [],
      filesDeleted: [],
      reason: message,
    };
  }
}
