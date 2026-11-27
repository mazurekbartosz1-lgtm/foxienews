import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import type {
  NoteIntent,
  OrganizeInboxResult,
  PlanningRunResult,
  ResearchRunResult,
} from "../types/api.js";
import type { VaultStore } from "./firestoreStore.js";
import {
  isGitConflictError,
  type AtomicFileChange,
  type GitHubVaultClient,
} from "./github.js";
import {
  createGoogleWorkspaceClient,
  type GoogleWorkspaceClient,
} from "./googleWorkspace.js";
import { slugifyPolish } from "./markdown.js";
import {
  runPlanningAgent,
  type EnrichActionableContextFn,
  type ExtractPlanFn,
} from "./planningAgent.js";
import { runResearchAgent, type GenerateResearchReportFn } from "./researchAgent.js";
import {
  runVaultCommandAgent,
  type BuildVaultCommandPlanFn,
  type SelectRelevantFilesFn,
} from "./vaultCommandAgent.js";
import { parseFrontmatter } from "./wikiParser.js";
import { extractVaultRelativePath } from "./wikiSync.js";

export type IndexSectionName =
  | "Projekty"
  | "Obszary"
  | "Pomysły"
  | "Zasoby"
  | "Dziennik";

export interface OrganizerDecision {
  intent: NoteIntent;
  targetPath: string;
  title: string;
  summary: string;
  tags: string[];
  relatedLinks: string[];
  sectionHeading?: string;
  contentMarkdown: string;
  tasks: string[];
  indexSection: IndexSectionName;
  indexDescription: string;
  logEntry: string;
  isTestNote?: boolean;
}

export type ClassifyInboxNoteFn = (params: {
  inboxRelativePath: string;
  rawMarkdown: string;
  schemaMarkdown: string;
  wikiIndexMarkdown: string;
  existingWikiPaths: string[];
  noteDate: string;
}) => Promise<OrganizerDecision>;

const VALID_INTENTS = new Set<NoteIntent>([
  "knowledge",
  "project",
  "plan-calendar",
  "todo",
  "research-idea",
  "journal",
  "vault-command",
]);

const VALID_INDEX_SECTIONS = new Set<IndexSectionName>([
  "Projekty",
  "Obszary",
  "Pomysły",
  "Zasoby",
  "Dziennik",
]);

const ALLOWED_WIKI_PREFIXES = [
  "wiki/projekty/",
  "wiki/obszary/",
  "wiki/pomysly/",
  "wiki/zasoby/",
  "wiki/dziennik/",
];

const PROTECTED_WIKI_PATHS = new Set([
  "wiki/index.md",
  "wiki/log.md",
  "wiki/projekty/foxie-notes/status.md",
  "wiki/projekty/foxie-notes/index.md",
  "wiki/projekty/foxie-notes/sprzet-waveshare-v2.md",
]);

function isProtectedFoxieProjectDoc(rebuilt: string): boolean {
  return (
    PROTECTED_WIKI_PATHS.has(rebuilt) ||
    rebuilt.startsWith("wiki/projekty/foxie-notes/zadania/")
  );
}

function joinRepoPath(vaultPrefix: string | undefined, relativePath: string): string {
  const cleanPrefix = (vaultPrefix ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const cleanRel = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return cleanPrefix ? `${cleanPrefix}/${cleanRel}` : cleanRel;
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }
  return trimmed;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeTag(tag: string): string {
  const cleaned = slugifyPolish(tag.replace(/^#/, "").trim());
  return cleaned === "notatka" && tag.replace(/^#/, "").trim().toLowerCase() !== "notatka"
    ? ""
    : cleaned;
}

function normalizeTagsList(tags: readonly string[], extra: readonly string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...tags, ...extra]) {
    const t = normalizeTag(raw);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export function extractNoteTimestamp(
  inboxRelativePath: string,
  rawMarkdown: string,
  fallbackNow: Date,
): { date: string; time: string; yearMonth: string } {
  const fmMatch = rawMarkdown.match(/created_at\s*:\s*["']?(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/i);
  if (fmMatch) {
    return {
      date: fmMatch[1],
      time: `${fmMatch[2]}:${fmMatch[3]}`,
      yearMonth: fmMatch[1].slice(0, 7),
    };
  }

  const fileMatch = path.posix
    .basename(inboxRelativePath)
    .match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
  if (fileMatch) {
    return {
      date: fileMatch[1],
      time: `${fileMatch[2]}:${fileMatch[3]}`,
      yearMonth: fileMatch[1].slice(0, 7),
    };
  }

  const iso = fallbackNow.toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
    yearMonth: iso.slice(0, 7),
  };
}

export function buildProcessedPath(inboxRelativePath: string, yearMonth: string): string {
  const fileName = path.posix.basename(inboxRelativePath.replace(/\\/g, "/"));
  return `raw/processed/${yearMonth}/${fileName}`;
}

export function sanitizeTargetPath(params: {
  rawTargetPath: string;
  noteDate: string;
  isTestNote?: boolean;
  title?: string;
}): string {
  if (params.isTestNote) {
    return `wiki/dziennik/${params.noteDate}.md`;
  }

  let normalized = params.rawTargetPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  if (normalized.startsWith("vault/")) {
    normalized = normalized.slice("vault/".length);
  }
  if (!normalized.startsWith("wiki/")) {
    normalized = `wiki/${normalized}`;
  }
  if (!/\.md$/i.test(normalized)) {
    normalized = `${normalized}.md`;
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === "..")) {
    return `wiki/dziennik/${params.noteDate}.md`;
  }

  const cleanSegments = segments.map((seg, idx) => {
    if (idx === 0) return "wiki";
    if (idx === segments.length - 1) {
      const base = seg.replace(/\.md$/i, "");
      if (/^\d{4}-\d{2}-\d{2}$/.test(base)) {
        return `${base}.md`;
      }
      return `${slugifyPolish(base)}.md`;
    }
    return slugifyPolish(seg);
  });

  if (
    cleanSegments[1] === "projekty" &&
    cleanSegments.length >= 3 &&
    ["foxy-news", "foxing-news", "foxie-news"].includes(cleanSegments[2])
  ) {
    cleanSegments[2] = "foxie-notes";
  }

  const rebuilt = cleanSegments.join("/");
  if (isProtectedFoxieProjectDoc(rebuilt)) {
    if (rebuilt.startsWith("wiki/projekty/foxie-notes/")) {
      return "wiki/projekty/foxie-notes/notatki.md";
    }
    return `wiki/dziennik/${params.noteDate}.md`;
  }

  if (!ALLOWED_WIKI_PREFIXES.some((prefix) => rebuilt.startsWith(prefix))) {
    const slug = slugifyPolish(params.title || "notatka");
    return `wiki/zasoby/${slug}.md`;
  }

  return rebuilt;
}

function inferIndexSectionFromPath(targetPath: string): IndexSectionName {
  if (targetPath.startsWith("wiki/projekty/")) return "Projekty";
  if (targetPath.startsWith("wiki/obszary/")) return "Obszary";
  if (targetPath.startsWith("wiki/pomysly/")) return "Pomysły";
  if (targetPath.startsWith("wiki/dziennik/")) return "Dziennik";
  return "Zasoby";
}

export async function classifyInboxNoteWithGemini(params: {
  inboxRelativePath: string;
  rawMarkdown: string;
  schemaMarkdown: string;
  wikiIndexMarkdown: string;
  existingWikiPaths: string[];
  noteDate: string;
}): Promise<OrganizerDecision> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY configuration");
  }

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";
  const ai = new GoogleGenAI({ apiKey });

  const existingList =
    params.existingWikiPaths.length > 0
      ? params.existingWikiPaths.map((p) => `- ${p}`).join("\n")
      : "(brak istniejących stron)";

  const prompt = `Jesteś Agentem Organizatorem prywatnego vaulta Obsidian (taksonomia PARA + Dziennik).
Twoim zadaniem jest przeanalizowanie nowej surowej notatki z \`raw/inbox/\` i wskazanie, gdzie i w jakiej formie ją zapisać w \`wiki/\`.

ZASADY TAKSONOMII (SCHEMA.md):
${params.schemaMarkdown}

ISTNIEJĄCE PLIKI W WIKI (preferuj dopisywanie do istniejącego logicznego tematu zamiast mnożenia podobnych plików):
${existingList}

AKTUALNY SPIS TREŚCI (wiki/index.md):
${params.wikiIndexMarkdown}

NOWA NOTATKA DO PRZETWORZENIA (${params.inboxRelativePath}, data notatki: ${params.noteDate}):
\`\`\`markdown
${params.rawMarkdown}
\`\`\`

REGUŁY DECYZJI:
1. Dobierz dokładnie jedną ścieżkę \`targetPath\` zaczynającą się od:
   - \`wiki/projekty/<projekt>/<temat>.md\` (dla aktywnych projektów; wszystkie notatki dotyczące projektu Foxie Notes — w tym literówki z transkrypcji głosowej typu "Foxy News", "Foxing News", "Foxie News" — MUSZĄ trafiać do \`wiki/projekty/foxie-notes/notatki.md\`, nigdy nie twórz osobnych katalogów \`foxing-news/\` ani \`foxy-news/\`)
   - \`wiki/obszary/<obszar>/<temat>.md\` (stałe obszary życia, np. \`wiki/obszary/dom/zakupy.md\`, \`wiki/obszary/auto/toyota.md\`, \`wiki/obszary/zdrowie/samopoczucie.md\`)
   - \`wiki/pomysly/<temat>.md\` (nowe pomysły i koncepcje do analizy -> intent \`research-idea\`)
   - \`wiki/zasoby/<temat>.md\` (wiedza ogólna, notatki referencyjne)
   - \`wiki/dziennik/${params.noteDate}.md\` (obserwacje dnia, samopoczucie, krótkie zapiski dnia ORAZ nagrania testowe)
2. Jeśli notatka jest testem dyktafonu, konfiguracji lub spacerowym testem nagrania, ustaw \`isTestNote: true\`, \`intent: "journal"\`, \`targetPath: "wiki/dziennik/${params.noteDate}.md"\` i dodaj tag \`test\`.
   Jeśli notatka jest wyraźnym poleceniem zmiany struktury lub porządkowania repozytorium Obsidian / folderów / stron wiki (np. "zrób folder zdrowie i samopoczucie", "uporządkuj notatki o X jako oddzielne wiki", "przenieś wpisy o Y do Z"), ustaw \`intent: "vault-command"\`, \`targetPath: "wiki/dziennik/${params.noteDate}.md"\` (zostanie obsłużone bezpośrednio przez Kuratora Wiki bez dopisywania śmieciowego wpisu do dziennika).
3. Nigdy nie wybieraj chronionych plików: \`wiki/index.md\`, \`wiki/log.md\`, \`wiki/projekty/foxie-notes/status.md\`, \`wiki/projekty/foxie-notes/index.md\`, \`wiki/projekty/foxie-notes/sprzet-waveshare-v2.md\` ani żadnego pliku w \`wiki/projekty/foxie-notes/zadania/\`.
4. Zachowaj wszystkie konkretne fakty, godziny, kwoty, nazwy i zadania (z \`@due(YYYY-MM-DD)\` jeśli padła konkretna data). Konsoliduj powiązane kroki jednej sprawy w JEDNO konkretne zadanie — nie rozbijaj pojedynczej czynności na osobne meta-zadanie typu "znaleźć numer/sprawdzić adres" i właściwe wykonanie.
5. \`contentMarkdown\` nie może zawierać YAML frontmattera ani nagłówka H1 (\`# ...\`) ani sekcji \`## Zadania\` (zadania podaj wyłącznie w polu \`tasks\`).
6. Zwróć WYŁĄCZNIE poprawny obiekt JSON o polach:
{
  "intent": "knowledge" | "project" | "plan-calendar" | "todo" | "research-idea" | "journal" | "vault-command",
  "targetPath": "wiki/...",
  "title": "Czytelny tytuł strony po polsku",
  "summary": "1-2 krótkie zdania pod e-ink (max 160 znaków)",
  "tags": ["1-4 krótkie tagi bez #"],
  "relatedLinks": ["opcjonalne slugi bez [[]], np. projekty/foxie-notes/index"],
  "sectionHeading": "Krótki nagłówek sekcji dla tego wpisu (max 6 słów)",
  "contentMarkdown": "Zwięzła treść po polsku w Markdown (bez H1, bez frontmattera, bez sekcji Zadania)",
  "tasks": ["zadania bez prefiksu '- [ ]'; pusta tablica jeśli brak"],
  "indexSection": "Projekty" | "Obszary" | "Pomysły" | "Zasoby" | "Dziennik",
  "indexDescription": "1 krótkie zdanie opisu strony do wiki/index.md",
  "logEntry": "1 krótkie zdanie do wiki/log.md co dodano/zaktualizowano",
  "isTestNote": false
}`;

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
    },
  });

  const rawText = response.text?.trim() ?? "";
  if (!rawText) {
    throw new Error("Gemini organizer returned an empty response");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFences(rawText)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Gemini organizer returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const intentRaw = typeof parsed.intent === "string" ? parsed.intent.trim() : "knowledge";
  const intent: NoteIntent = VALID_INTENTS.has(intentRaw as NoteIntent)
    ? (intentRaw as NoteIntent)
    : "knowledge";

  const isTestNote = Boolean(parsed.isTestNote);
  const title =
    typeof parsed.title === "string" && parsed.title.trim()
      ? parsed.title.trim()
      : `Dziennik ${params.noteDate}`;

  const targetPath = sanitizeTargetPath({
    rawTargetPath:
      typeof parsed.targetPath === "string" ? parsed.targetPath : `wiki/dziennik/${params.noteDate}.md`,
    noteDate: params.noteDate,
    isTestNote,
    title,
  });

  const indexSectionRaw =
    typeof parsed.indexSection === "string" ? parsed.indexSection.trim() : "";
  const indexSection: IndexSectionName = VALID_INDEX_SECTIONS.has(
    indexSectionRaw as IndexSectionName,
  )
    ? (indexSectionRaw as IndexSectionName)
    : inferIndexSectionFromPath(targetPath);

  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 180)
      : title;

  const contentMarkdown =
    typeof parsed.contentMarkdown === "string" && parsed.contentMarkdown.trim()
      ? parsed.contentMarkdown.trim()
      : summary;

  const sectionHeading =
    typeof parsed.sectionHeading === "string" && parsed.sectionHeading.trim()
      ? parsed.sectionHeading.trim()
      : undefined;

  const indexDescription =
    typeof parsed.indexDescription === "string" && parsed.indexDescription.trim()
      ? parsed.indexDescription.trim()
      : summary;

  const logEntry =
    typeof parsed.logEntry === "string" && parsed.logEntry.trim()
      ? parsed.logEntry.trim()
      : `Dodano wpis do ${targetPath}`;

  const tags = normalizeTagsList(
    toStringArray(parsed.tags),
    isTestNote ? ["test", "dziennik"] : [],
  );

  return {
    intent: isTestNote ? "journal" : intent,
    targetPath,
    title: isTestNote ? `Dziennik ${params.noteDate}` : title,
    summary,
    tags,
    relatedLinks: toStringArray(parsed.relatedLinks).map((link) =>
      link.replace(/^\[\[|\]\]$/g, "").replace(/\.md$/i, "").trim(),
    ),
    sectionHeading,
    contentMarkdown,
    tasks: toStringArray(parsed.tasks).map((task) =>
      task.replace(/^\s*[-*]\s*\[[ xX]\]\s*/, "").trim(),
    ),
    indexSection: isTestNote ? "Dziennik" : indexSection,
    indexDescription,
    logEntry,
    isTestNote,
  };
}

function escapeYaml(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, " ").trim());
}

function stripLeadingHeading(markdown: string): string {
  return markdown.replace(/^\s*#\s+[^\n]+\n*/m, "").trim();
}

function formatTasksList(tasks: readonly string[]): string[] {
  return tasks
    .map((task) => task.replace(/^\s*[-*]\s*\[[ xX]\]\s*/, "").trim())
    .filter(Boolean);
}

function formatSectionBlock(params: {
  targetPath: string;
  noteTime: string;
  sectionHeading?: string;
  contentMarkdown: string;
  isTestNote?: boolean;
}): string {
  const cleanBody = stripLeadingHeading(params.contentMarkdown);
  const headingLabel = params.sectionHeading?.trim() || "Wpis";
  const isJournal = params.targetPath.startsWith("wiki/dziennik/");
  const testBadge = params.isTestNote ? " `#test`" : "";
  const heading = isJournal
    ? `## ${params.noteTime} — ${headingLabel}${testBadge}`
    : `## ${headingLabel}${testBadge}`;

  return cleanBody ? `${heading}\n\n${cleanBody}` : heading;
}

export function renderNewWikiPage(params: {
  targetPath: string;
  title: string;
  summary: string;
  tags: readonly string[];
  relatedLinks: readonly string[];
  sectionHeading?: string;
  contentMarkdown: string;
  tasks: readonly string[];
  processedPath: string;
  noteTime: string;
  updatedAtIso: string;
  isTestNote?: boolean;
}): string {
  const slug = params.targetPath.replace(/^wiki\//i, "").replace(/\.md$/i, "");
  const tags = normalizeTagsList(params.tags);
  const cleanTasks = formatTasksList(params.tasks);

  const lines: string[] = [
    "---",
    `title: ${escapeYaml(params.title)}`,
    `slug: ${slug}`,
    `updated_at: ${params.updatedAtIso}`,
    `tags: [${tags.join(", ")}]`,
    `summary: ${escapeYaml(params.summary)}`,
    "---",
    "",
    `# ${params.title}`,
    "",
    params.summary,
    "",
  ];

  if (params.relatedLinks.length > 0) {
    const formattedLinks = params.relatedLinks.map((l) => `[[${l}]]`).join(", ");
    lines.push(`Powiązane: ${formattedLinks}`, "");
  }

  lines.push(
    formatSectionBlock({
      targetPath: params.targetPath,
      noteTime: params.noteTime,
      sectionHeading: params.sectionHeading,
      contentMarkdown: params.contentMarkdown,
      isTestNote: params.isTestNote,
    }),
    "",
  );

  if (cleanTasks.length > 0) {
    lines.push("## Zadania");
    for (const task of cleanTasks) {
      lines.push(`- [ ] ${task}`);
    }
    lines.push("");
  }

  lines.push("## Źródła", `- \`${params.processedPath}\``, "");
  return lines.join("\n");
}

function splitSectionsAtH2(body: string): {
  preamble: string;
  sections: Array<{ heading: string; content: string }>;
} {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const preambleLines: string[] = [];
  const sections: Array<{ heading: string; contentLines: string[] }> = [];
  let current: { heading: string; contentLines: string[] } | null = null;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      current = { heading: h2[1].trim(), contentLines: [] };
      sections.push(current);
      continue;
    }
    if (current) {
      current.contentLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }

  return {
    preamble: preambleLines.join("\n").trimEnd(),
    sections: sections.map((sec) => ({
      heading: sec.heading,
      content: sec.contentLines.join("\n").trim(),
    })),
  };
}

export function mergeIntoExistingWikiPage(params: {
  existingMarkdown: string;
  targetPath: string;
  tags: readonly string[];
  sectionHeading?: string;
  contentMarkdown: string;
  tasks: readonly string[];
  processedPath: string;
  noteTime: string;
  updatedAtIso: string;
  fallbackTitle: string;
  fallbackSummary: string;
  isTestNote?: boolean;
}): string {
  const { frontmatter, body } = parseFrontmatter(params.existingMarkdown);
  const slug =
    frontmatter.slug || params.targetPath.replace(/^wiki\//i, "").replace(/\.md$/i, "");
  const title = frontmatter.title || params.fallbackTitle;
  const summary = frontmatter.summary || params.fallbackSummary;
  const mergedTags = normalizeTagsList(frontmatter.tags, params.tags);

  const { preamble, sections } = splitSectionsAtH2(body);

  let tasksSection = sections.find((s) => s.heading.toLowerCase() === "zadania");
  let sourcesSection = sections.find(
    (s) => s.heading.toLowerCase() === "źródła" || s.heading.toLowerCase() === "zrodla",
  );
  const googleSyncSections = sections.filter(
    (s) => s.heading.toLowerCase() === "synchronizacja google",
  );
  const googleSyncContent = googleSyncSections
    .map((s) => s.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const regularSections = sections.filter(
    (s) => s !== tasksSection && s !== sourcesSection && !googleSyncSections.includes(s),
  );

  const newBlock = formatSectionBlock({
    targetPath: params.targetPath,
    noteTime: params.noteTime,
    sectionHeading: params.sectionHeading,
    contentMarkdown: params.contentMarkdown,
    isTestNote: params.isTestNote,
  });

  // Append new tasks without duplicating exact task lines
  const existingTaskLines = tasksSection
    ? tasksSection.content
        .split("\n")
        .map((l) => l.trimEnd())
        .filter(Boolean)
    : [];
  const normalizedExistingTasks = new Set(
    existingTaskLines.map((l) => l.replace(/^\s*[-*]\s*\[[ xX]\]\s*/, "").trim().toLowerCase()),
  );
  for (const task of formatTasksList(params.tasks)) {
    if (!normalizedExistingTasks.has(task.toLowerCase())) {
      existingTaskLines.push(`- [ ] ${task}`);
      normalizedExistingTasks.add(task.toLowerCase());
    }
  }
  if (existingTaskLines.length > 0) {
    tasksSection = { heading: "Zadania", content: existingTaskLines.join("\n") };
  }

  // Append processed source path idempotently
  const existingSourceLines = sourcesSection
    ? sourcesSection.content
        .split("\n")
        .map((l) => l.trimEnd())
        .filter(Boolean)
    : [];
  const sourceLine = `- \`${params.processedPath}\``;
  if (!existingSourceLines.some((l) => l.includes(params.processedPath))) {
    existingSourceLines.push(sourceLine);
  }
  sourcesSection = { heading: "Źródła", content: existingSourceLines.join("\n") };

  const out: string[] = [
    "---",
    `title: ${escapeYaml(title)}`,
    `slug: ${slug}`,
    `updated_at: ${params.updatedAtIso}`,
    `tags: [${mergedTags.join(", ")}]`,
    `summary: ${escapeYaml(summary)}`,
    "---",
    "",
  ];

  if (preamble.trim()) {
    out.push(preamble.trim(), "");
  } else {
    out.push(`# ${title}`, "", summary, "");
  }

  for (const sec of regularSections) {
    out.push(`## ${sec.heading}`);
    if (sec.content) {
      out.push(sec.content);
    }
    out.push("");
  }

  out.push(newBlock, "");

  if (tasksSection) {
    out.push(`## ${tasksSection.heading}`, tasksSection.content, "");
  }

  out.push(`## ${sourcesSection.heading}`, sourcesSection.content, "");

  if (googleSyncContent) {
    out.push("## Synchronizacja Google", googleSyncContent, "");
  }

  return out.join("\n");
}

function updateFrontmatterUpdatedAt(markdown: string, updatedAtIso: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!fmMatch) {
    return normalized;
  }

  const block = fmMatch[1];
  const rest = normalized.slice(fmMatch[0].length);
  const updatedBlock = /^updated_at\s*:/m.test(block)
    ? block.replace(/^updated_at\s*:.*$/m, `updated_at: ${updatedAtIso}`)
    : `${block}\nupdated_at: ${updatedAtIso}`;

  return `---\n${updatedBlock}\n---\n${rest}`;
}

export function updateWikiIndexMarkdown(params: {
  existingIndexMarkdown: string | null;
  slug: string;
  title: string;
  description: string;
  section: IndexSectionName;
  updatedAtIso: string;
}): { markdown: string; changed: boolean } {
  const base =
    params.existingIndexMarkdown?.trim() ||
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
    ].join("\n");

  const withTimestamp = updateFrontmatterUpdatedAt(base, params.updatedAtIso);
  const escapedSlug = params.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const linkPattern = new RegExp(`\\[\\[${escapedSlug}(?:\\||\\]\\])`, "i");
  if (linkPattern.test(withTimestamp)) {
    return { markdown: base.endsWith("\n") ? base : `${base}\n`, changed: false };
  }

  const bullet = `- [[${params.slug}|${params.title}]] — ${params.description}`;
  const lines = withTimestamp.split("\n");
  const targetHeader = `## ${params.section}`;
  const sectionIdx = lines.findIndex(
    (line) => line.trim().toLowerCase() === targetHeader.toLowerCase(),
  );

  if (sectionIdx >= 0) {
    let insertAt = sectionIdx + 1;
    while (insertAt < lines.length && !/^##\s+/.test(lines[insertAt])) {
      insertAt++;
    }
    while (insertAt > sectionIdx + 1 && lines[insertAt - 1].trim() === "") {
      insertAt--;
    }
    lines.splice(insertAt, 0, bullet);
  } else {
    const systemIdx = lines.findIndex((line) => line.trim().toLowerCase() === "## system");
    const block = [targetHeader, bullet, ""];
    if (systemIdx >= 0) {
      lines.splice(systemIdx, 0, ...block);
    } else {
      if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
        lines.push("");
      }
      lines.push(...block);
    }
  }

  const joined = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
  return { markdown: joined, changed: true };
}

export function prependWikiLogMarkdown(params: {
  existingLogMarkdown: string | null;
  dateStr: string;
  updatedAtIso: string;
  intent: NoteIntent;
  logEntry: string;
  slug: string;
  title: string;
  processedPath: string;
}): string {
  const base =
    params.existingLogMarkdown?.trim() ||
    [
      "---",
      "title: Dziennik zmian",
      "slug: log",
      `updated_at: ${params.updatedAtIso}`,
      "tags: [log]",
      "---",
      "",
      "# Dziennik zmian (LLM Wiki & Rozwój Projektu)",
      "",
    ].join("\n");

  const withTimestamp = updateFrontmatterUpdatedAt(base, params.updatedAtIso);
  const entryLine = `- **Agent Organizator (\`${params.intent}\`):** ${params.logEntry} ([[${params.slug}|${params.title}]], źródło: \`${params.processedPath}\`).`;

  const lines = withTimestamp.split("\n");
  const dateHeader = `## ${params.dateStr}`;
  const existingDateIdx = lines.findIndex((line) => line.trim() === dateHeader);

  if (existingDateIdx >= 0) {
    lines.splice(existingDateIdx + 1, 0, entryLine);
  } else {
    const h1Idx = lines.findIndex((line) => /^#\s+/.test(line.trim()));
    const insertAt = h1Idx >= 0 ? h1Idx + 1 : 0;
    const block = ["", dateHeader, entryLine];
    lines.splice(insertAt, 0, ...block);
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export async function organizeInboxFile(params: {
  inboxRepoPath: string;
  vaultClient: GitHubVaultClient;
  store: VaultStore;
  classifyNote?: ClassifyInboxNoteFn;
  generateResearchReport?: GenerateResearchReportFn;
  enableResearchAgent?: boolean;
  googleClient?: GoogleWorkspaceClient;
  extractPlan?: ExtractPlanFn;
  enrichContext?: EnrichActionableContextFn;
  enablePlanningAgent?: boolean;
  selectVaultCommandFiles?: SelectRelevantFilesFn;
  buildVaultCommandPlan?: BuildVaultCommandPlanFn;
  vaultPrefix?: string;
  now?: () => Date;
  maxAttempts?: number;
  force?: boolean;
}): Promise<OrganizeInboxResult> {
  const getNow = params.now ?? (() => new Date());
  const nowDate = getNow();
  const nowIso = nowDate.toISOString().replace(/\.\d{3}Z$/, "Z");
  const classify = params.classifyNote ?? classifyInboxNoteWithGemini;

  const inboxRelative = extractVaultRelativePath(params.inboxRepoPath, params.vaultPrefix);
  if (
    !inboxRelative ||
    !inboxRelative.startsWith("raw/inbox/") ||
    !/\.md$/i.test(inboxRelative)
  ) {
    return {
      inboxPath: params.inboxRepoPath,
      status: "skipped",
      reason: "not_an_inbox_markdown_file",
    };
  }

  const claim = await params.store.claimInboxJob({
    inboxPath: params.inboxRepoPath,
    nowIso,
    maxAttempts: params.maxAttempts,
    force: params.force,
  });

  if (!claim.claimed) {
    const reason =
      claim.existing?.status === "error"
        ? "max_attempts_reached"
        : `already_${claim.existing?.status ?? "claimed"}`;
    return {
      inboxPath: params.inboxRepoPath,
      status: "skipped",
      reason,
      targetPath: claim.existing?.targetPath,
      processedPath: claim.existing?.processedPath,
      commitSha: claim.existing?.commitSha,
    };
  }

  const attempts = claim.attempts ?? 1;
  const createdAt = claim.existing?.createdAt ?? nowIso;

  try {
    const rawMarkdown = await params.vaultClient.fetchFile(params.inboxRepoPath);
    if (rawMarkdown === null) {
      await params.store.completeInboxJob({
        id: "",
        inboxPath: params.inboxRepoPath,
        status: "done",
        attempts,
        createdAt,
        updatedAt: nowIso,
        error: "Source file no longer present in raw/inbox/",
      });
      return {
        inboxPath: params.inboxRepoPath,
        status: "skipped",
        reason: "source_file_missing",
      };
    }

    const schemaRepoPath = joinRepoPath(params.vaultPrefix, "SCHEMA.md");
    const indexRepoPath = joinRepoPath(params.vaultPrefix, "wiki/index.md");
    const logRepoPath = joinRepoPath(params.vaultPrefix, "wiki/log.md");

    const [treeEntries, schemaMd, indexMd, logMd] = await Promise.all([
      params.vaultClient.listTree(),
      params.vaultClient.fetchFile(schemaRepoPath),
      params.vaultClient.fetchFile(indexRepoPath),
      params.vaultClient.fetchFile(logRepoPath),
    ]);

    const existingWikiPaths = treeEntries
      .filter((entry) => entry.type === "blob" && /\.md$/i.test(entry.path))
      .map((entry) => extractVaultRelativePath(entry.path, params.vaultPrefix))
      .filter((rel): rel is string => Boolean(rel && rel.startsWith("wiki/")))
      .sort();

    const { date: noteDate, time: noteTime, yearMonth } = extractNoteTimestamp(
      inboxRelative,
      rawMarkdown,
      nowDate,
    );

    const decision = await classify({
      inboxRelativePath: inboxRelative,
      rawMarkdown,
      schemaMarkdown: schemaMd ?? "",
      wikiIndexMarkdown: indexMd ?? "",
      existingWikiPaths,
      noteDate,
    });

    const processedRelativePath = buildProcessedPath(inboxRelative, yearMonth);
    const processedRepoPath = joinRepoPath(params.vaultPrefix, processedRelativePath);

    if (decision.intent === "vault-command") {
      const { body: commandBody } = parseFrontmatter(rawMarkdown);
      const commandText = commandBody.trim() || rawMarkdown.trim();
      const vaultCommandResult = await runVaultCommandAgent({
        command: commandText,
        vaultClient: params.vaultClient,
        selectFiles: params.selectVaultCommandFiles,
        buildPlan: params.buildVaultCommandPlan,
        vaultPrefix: params.vaultPrefix,
        extraChanges: [
          { path: processedRepoPath, content: rawMarkdown },
          { path: params.inboxRepoPath, content: null },
        ],
        now: getNow,
      });

      if (vaultCommandResult.status !== "executed") {
        throw new Error(
          vaultCommandResult.reason ??
            vaultCommandResult.summary ??
            "VaultCommandAgent did not execute",
        );
      }

      const primaryTargetPath = vaultCommandResult.filesWritten[0]
        ? joinRepoPath(params.vaultPrefix, vaultCommandResult.filesWritten[0])
        : undefined;

      await params.store.completeInboxJob({
        id: "",
        inboxPath: params.inboxRepoPath,
        processedPath: processedRepoPath,
        status: "done",
        attempts,
        intent: "vault-command",
        ...(primaryTargetPath ? { targetPath: primaryTargetPath } : {}),
        ...(vaultCommandResult.commitSha ? { commitSha: vaultCommandResult.commitSha } : {}),
        vaultCommandSummary: vaultCommandResult.summary,
        vaultCommandFiles: vaultCommandResult.filesWritten,
        createdAt,
        updatedAt: nowIso,
      });

      return {
        inboxPath: params.inboxRepoPath,
        status: "processed",
        intent: "vault-command",
        ...(primaryTargetPath ? { targetPath: primaryTargetPath } : {}),
        processedPath: processedRepoPath,
        ...(vaultCommandResult.commitSha ? { commitSha: vaultCommandResult.commitSha } : {}),
        vaultCommand: vaultCommandResult,
      };
    }

    const targetRelativePath = sanitizeTargetPath({
      rawTargetPath: decision.targetPath,
      noteDate,
      isTestNote: decision.isTestNote,
      title: decision.title,
    });
    const targetRepoPath = joinRepoPath(params.vaultPrefix, targetRelativePath);
    const targetSlug = targetRelativePath.replace(/^wiki\//i, "").replace(/\.md$/i, "");

    const maxCommitAttempts = 4;
    let commitRes: { commitSha: string; treeSha: string; branch: string } | undefined;

    for (let attempt = 0; attempt < maxCommitAttempts; attempt++) {
      let currentIndexMd = indexMd;
      let currentLogMd = logMd;
      let existingTargetMd: string | null = null;

      if (attempt > 0) {
        const backoffMs = 250 * attempt + Math.floor(Math.random() * 250);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));

        const latestInbox = await params.vaultClient.fetchFile(params.inboxRepoPath);
        if (latestInbox === null) {
          await params.store.completeInboxJob({
            id: "",
            inboxPath: params.inboxRepoPath,
            status: "done",
            attempts,
            createdAt,
            updatedAt: nowIso,
            error: "Source file no longer present in raw/inbox/",
          });
          return {
            inboxPath: params.inboxRepoPath,
            status: "skipped",
            reason: "source_file_missing",
          };
        }

        const [freshTargetMd, freshIndexMd, freshLogMd] = await Promise.all([
          params.vaultClient.fetchFile(targetRepoPath),
          params.vaultClient.fetchFile(indexRepoPath),
          params.vaultClient.fetchFile(logRepoPath),
        ]);
        existingTargetMd = freshTargetMd;
        currentIndexMd = freshIndexMd;
        currentLogMd = freshLogMd;
      } else if (existingWikiPaths.includes(targetRelativePath)) {
        existingTargetMd = await params.vaultClient.fetchFile(targetRepoPath);
      }

      const nextPageMarkdown = existingTargetMd
        ? mergeIntoExistingWikiPage({
            existingMarkdown: existingTargetMd,
            targetPath: targetRelativePath,
            tags: decision.tags,
            sectionHeading: decision.sectionHeading,
            contentMarkdown: decision.contentMarkdown,
            tasks: decision.tasks,
            processedPath: processedRelativePath,
            noteTime,
            updatedAtIso: nowIso,
            fallbackTitle: decision.title,
            fallbackSummary: decision.summary,
            isTestNote: decision.isTestNote,
          })
        : renderNewWikiPage({
            targetPath: targetRelativePath,
            title: decision.title,
            summary: decision.summary,
            tags: decision.tags,
            relatedLinks: decision.relatedLinks,
            sectionHeading: decision.sectionHeading,
            contentMarkdown: decision.contentMarkdown,
            tasks: decision.tasks,
            processedPath: processedRelativePath,
            noteTime,
            updatedAtIso: nowIso,
            isTestNote: decision.isTestNote,
          });

      const { markdown: nextIndexMd, changed: indexChanged } = updateWikiIndexMarkdown({
        existingIndexMarkdown: currentIndexMd,
        slug: targetSlug,
        title: decision.title,
        description: decision.indexDescription,
        section: decision.indexSection,
        updatedAtIso: nowIso,
      });

      const nextLogMd = prependWikiLogMarkdown({
        existingLogMarkdown: currentLogMd,
        dateStr: nowIso.slice(0, 10),
        updatedAtIso: nowIso,
        intent: decision.intent,
        logEntry: decision.logEntry,
        slug: targetSlug,
        title: decision.title,
        processedPath: processedRelativePath,
      });

      const changes: AtomicFileChange[] = [
        { path: targetRepoPath, content: nextPageMarkdown },
        ...(indexChanged ? [{ path: indexRepoPath, content: nextIndexMd }] : []),
        { path: logRepoPath, content: nextLogMd },
        { path: processedRepoPath, content: rawMarkdown },
        { path: params.inboxRepoPath, content: null },
      ];

      try {
        commitRes = await params.vaultClient.commitAtomicChanges({
          changes,
          commitMessage: `agent(organizer): ${decision.title} (${decision.intent})`,
          maxRetries: 0,
        });
        break;
      } catch (commitErr) {
        if (isGitConflictError(commitErr) && attempt + 1 < maxCommitAttempts) {
          continue;
        }
        throw commitErr;
      }
    }

    if (!commitRes) {
      throw new Error("Failed to commit organized inbox note after retries");
    }

    let researchResult: ResearchRunResult | undefined;
    if (decision.intent === "research-idea" && params.enableResearchAgent !== false) {
      try {
        researchResult = await runResearchAgent({
          topicTitle: decision.title,
          noteMarkdown: rawMarkdown,
          sourcePath: processedRepoPath,
          targetWikiPath: targetRelativePath,
          extraTags: decision.tags,
          vaultClient: params.vaultClient,
          generateReport: params.generateResearchReport,
          vaultPrefix: params.vaultPrefix,
          now: getNow,
          force: params.force,
        });
      } catch (researchErr) {
        const researchMessage =
          researchErr instanceof Error ? researchErr.message : String(researchErr);
        console.error("[inboxOrganizer] Research agent error:", researchMessage);
        researchResult = {
          status: "error",
          topicSlug: slugifyPolish(decision.title),
          reason: researchMessage,
        };
      }
    }

    let planningResult: PlanningRunResult | undefined;
    if (
      (decision.intent === "plan-calendar" || decision.intent === "todo") &&
      params.enablePlanningAgent !== false
    ) {
      const gClient = params.googleClient ?? createGoogleWorkspaceClient();
      if (gClient.isConfigured()) {
        try {
          planningResult = await runPlanningAgent({
            topicTitle: decision.title,
            noteMarkdown: rawMarkdown,
            sourcePath: processedRepoPath,
            targetRepoPath,
            googleClient: gClient,
            vaultClient: params.vaultClient,
            extractPlan: params.extractPlan,
            enrichContext: params.enrichContext,
            now: getNow,
          });
        } catch (planErr) {
          const planMessage =
            planErr instanceof Error ? planErr.message : String(planErr);
          console.error("[inboxOrganizer] Planning agent error:", planMessage);
          planningResult = {
            status: "error",
            calendarEventsCreated: [],
            tasksCreated: [],
            listItemsCreated: [],
            reason: planMessage,
          };
        }
      }
    }

    const googleEventIds =
      planningResult?.calendarEventsCreated.map((ev) => ev.id) ?? [];
    const googleTaskIds = [
      ...(planningResult?.tasksCreated.map((t) => t.id) ?? []),
      ...(planningResult?.listItemsCreated.map((li) => li.id) ?? []),
    ];
    const googleListsUsed = Array.from(
      new Set([
        ...(planningResult?.tasksCreated.map((t) => t.listName) ?? []),
        ...(planningResult?.listItemsCreated.map((li) => li.listName) ?? []),
      ]),
    );

    await params.store.completeInboxJob({
      id: "",
      inboxPath: params.inboxRepoPath,
      processedPath: processedRepoPath,
      status: "done",
      attempts,
      intent: decision.intent,
      targetPath: targetRepoPath,
      commitSha: commitRes.commitSha,
      ...(researchResult?.prUrl ? { researchPrUrl: researchResult.prUrl } : {}),
      ...(researchResult?.prNumber !== undefined
        ? { researchPrNumber: researchResult.prNumber }
        : {}),
      ...(researchResult?.branch ? { researchBranch: researchResult.branch } : {}),
      ...(researchResult?.reportPath ? { researchReportPath: researchResult.reportPath } : {}),
      ...(planningResult ? { planningStatus: planningResult.status } : {}),
      ...(googleEventIds.length > 0 ? { googleEventIds } : {}),
      ...(googleTaskIds.length > 0 ? { googleTaskIds } : {}),
      ...(googleListsUsed.length > 0 ? { googleListsUsed } : {}),
      createdAt,
      updatedAt: nowIso,
    });

    return {
      inboxPath: params.inboxRepoPath,
      status: "processed",
      intent: decision.intent,
      targetPath: targetRepoPath,
      processedPath: processedRepoPath,
      commitSha: commitRes.commitSha,
      ...(researchResult ? { research: researchResult } : {}),
      ...(planningResult ? { planning: planningResult } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await params.store.completeInboxJob({
      id: "",
      inboxPath: params.inboxRepoPath,
      status: "error",
      attempts,
      error: message,
      createdAt,
      updatedAt: nowIso,
    });
    return {
      inboxPath: params.inboxRepoPath,
      status: "error",
      reason: message,
    };
  }
}

export async function organizePendingInboxFiles(params: {
  vaultClient: GitHubVaultClient;
  store: VaultStore;
  classifyNote?: ClassifyInboxNoteFn;
  generateResearchReport?: GenerateResearchReportFn;
  enableResearchAgent?: boolean;
  googleClient?: GoogleWorkspaceClient;
  extractPlan?: ExtractPlanFn;
  enrichContext?: EnrichActionableContextFn;
  enablePlanningAgent?: boolean;
  selectVaultCommandFiles?: SelectRelevantFilesFn;
  buildVaultCommandPlan?: BuildVaultCommandPlanFn;
  vaultPrefix?: string;
  paths?: string[];
  limit?: number;
  maxAttempts?: number;
  force?: boolean;
  now?: () => Date;
}): Promise<{
  processed: number;
  skipped: number;
  errors: number;
  results: OrganizeInboxResult[];
}> {
  let targetPaths: string[];
  if (params.paths && params.paths.length > 0) {
    targetPaths = params.paths.map((p) => p.trim()).filter(Boolean);
  } else {
    const tree = await params.vaultClient.listTree();
    targetPaths = tree
      .filter((entry) => entry.type === "blob" && /\.md$/i.test(entry.path))
      .map((entry) => ({
        repoPath: entry.path,
        rel: extractVaultRelativePath(entry.path, params.vaultPrefix),
      }))
      .filter(
        (item): item is { repoPath: string; rel: string } =>
          Boolean(item.rel && item.rel.startsWith("raw/inbox/")),
      )
      .map((item) => item.repoPath)
      .sort();
  }

  const maxCount = params.limit && params.limit > 0 ? params.limit : targetPaths.length;
  const slice = targetPaths.slice(0, maxCount);

  const results: OrganizeInboxResult[] = [];
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const inboxRepoPath of slice) {
    const result = await organizeInboxFile({
      inboxRepoPath,
      vaultClient: params.vaultClient,
      store: params.store,
      classifyNote: params.classifyNote,
      generateResearchReport: params.generateResearchReport,
      enableResearchAgent: params.enableResearchAgent,
      googleClient: params.googleClient,
      extractPlan: params.extractPlan,
      enrichContext: params.enrichContext,
      enablePlanningAgent: params.enablePlanningAgent,
      selectVaultCommandFiles: params.selectVaultCommandFiles,
      buildVaultCommandPlan: params.buildVaultCommandPlan,
      vaultPrefix: params.vaultPrefix,
      now: params.now,
      maxAttempts: params.maxAttempts,
      force: params.force,
    });
    results.push(result);
    if (result.status === "processed") processed++;
    else if (result.status === "skipped") skipped++;
    else errors++;
  }

  return { processed, skipped, errors, results };
}
