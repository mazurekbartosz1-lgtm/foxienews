import { GoogleGenAI } from "@google/genai";
import type { ResearchRunResult } from "../types/api.js";
import type { GitHubVaultClient } from "./github.js";
import { slugifyPolish } from "./markdown.js";
import { extractVaultRelativePath } from "./wikiSync.js";

export interface ResearchSource {
  title: string;
  uri: string;
}

export interface GeneratedResearchReport {
  title: string;
  summary: string;
  reportMarkdown: string;
  sources: ResearchSource[];
  searchQueries: string[];
  grounded: boolean;
}

export type GenerateResearchReportFn = (params: {
  topicTitle: string;
  noteMarkdown: string;
  targetWikiPath?: string;
  noteDate: string;
}) => Promise<GeneratedResearchReport>;

function joinRepoPath(vaultPrefix: string | undefined, relativePath: string): string {
  const cleanPrefix = (vaultPrefix ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const cleanRel = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return cleanPrefix ? `${cleanPrefix}/${cleanRel}` : cleanRel;
}

function escapeYaml(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, " ").trim());
}

function normalizeTagsList(extraTags: readonly string[] = []): string[] {
  const out: string[] = ["research", "pomysl"];
  const seen = new Set<string>(out);
  for (const raw of extraTags) {
    const cleaned = slugifyPolish(raw.replace(/^#/, "").trim());
    if (cleaned && cleaned !== "notatka" && !seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

export function buildResearchPaths(params: {
  topicTitle: string;
  targetWikiPath?: string;
}): {
  topicSlug: string;
  reportRelativePath: string;
  branchName: string;
} {
  let rawSlug = "";
  if (params.targetWikiPath) {
    const cleanTarget = params.targetWikiPath
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/^vault\//i, "");
    const match = cleanTarget.match(/^wiki\/pomysly\/([^/]+?)(?:\/index)?\.md$/i);
    if (match) {
      rawSlug = match[1];
    }
  }

  const topicSlug = slugifyPolish(rawSlug || params.topicTitle)
    .slice(0, 42)
    .replace(/-+$/g, "") || "pomysl";

  return {
    topicSlug,
    reportRelativePath: `wiki/pomysly/${topicSlug}/research.md`,
    branchName: `agent/research-${topicSlug}`,
  };
}

function stripLeadingFrontmatterAndH1(markdown: string): string {
  let text = markdown.replace(/\r\n/g, "\n").trim();
  const fmMatch = text.match(/^---\n[\s\S]*?\n---\n*/);
  if (fmMatch) {
    text = text.slice(fmMatch[0].length).trim();
  }
  text = text.replace(/^\s*#\s+[^\n]+\n*/m, "").trim();
  return text;
}

function extractSummaryFromReport(reportMarkdown: string, fallbackTitle: string): string {
  const clean = stripLeadingFrontmatterAndH1(reportMarkdown);
  const execMatch = clean.match(/##\s+Podsumowanie wykonawcze\s*\n+([\s\S]*?)(?:\n##\s+|$)/i);
  const sectionText = (execMatch ? execMatch[1] : clean)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join(" ");

  const plain = sectionText
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!plain) return fallbackTitle;
  return plain.length > 180 ? `${plain.slice(0, 177).trimEnd()}...` : plain;
}

function extractGroundingData(response: unknown): {
  sources: ResearchSource[];
  searchQueries: string[];
} {
  const candidates = (
    response as {
      candidates?: Array<{
        groundingMetadata?: {
          groundingChunks?: Array<{
            web?: { uri?: string; title?: string };
          }>;
          webSearchQueries?: string[];
        };
      }>;
    }
  )?.candidates;

  const metadata = candidates?.[0]?.groundingMetadata;
  const seenUris = new Set<string>();
  const sources: ResearchSource[] = [];

  for (const chunk of metadata?.groundingChunks ?? []) {
    const uri = chunk?.web?.uri?.trim();
    if (!uri || seenUris.has(uri)) continue;
    seenUris.add(uri);
    const title = chunk?.web?.title?.trim() || uri;
    sources.push({ title, uri });
  }

  const searchQueries = Array.from(
    new Set(
      (metadata?.webSearchQueries ?? [])
        .filter((q): q is string => typeof q === "string")
        .map((q) => q.trim())
        .filter(Boolean),
    ),
  );

  return { sources, searchQueries };
}

export async function generateResearchReportWithGemini(params: {
  topicTitle: string;
  noteMarkdown: string;
  targetWikiPath?: string;
  noteDate: string;
}): Promise<GeneratedResearchReport> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY configuration");
  }

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";
  const ai = new GoogleGenAI({ apiKey });

  const prompt = `Jesteś Agentem Researcherem prywatnej bazy wiedzy Obsidian (Foxie Notes).
Otrzymujesz pomysł użytkownika do pogłębionej analizy technicznej/praktycznej.
Przeprowadź rzetelny research (korzystając z wyszukiwania Google Search dla konkretnych parametrów, komponentów, cen, norm lub narzędzi) i przygotuj ustrukturyzowany raport w języku polskim.

TEMAT: ${params.topicTitle}
DATA NOTATKI: ${params.noteDate}

TREŚĆ POMYSŁU UŻYTKOWNIKA:
\`\`\`markdown
${params.noteMarkdown}
\`\`\`

WYMAGANIA FORMATU (czysty Markdown, BEZ YAML frontmattera i BEZ głównego nagłówka # H1):
Użyj dokładnie poniższych sekcji ## w tej kolejności:
## Podsumowanie wykonawcze
(2–3 zwięzłe, konkretne zdania z najważniejszym wnioskiem — czytelne także na małym ekranie e-ink)

## Problem i cel
(krótka definicja potrzeby, wymagań i ograniczeń)

## Warianty rozwiązania
(porównanie 2–4 konkretnych opcji / produktów / architektur z zaletami, wadami oraz przybliżonymi parametrami lub kosztami)

## Ryzyka i pułapki
(konkretne zagrożenia techniczne, kompatybilnościowe lub organizacyjne i jak im zapobiec)

## Rekomendacja
(jasny wybór najlepszego kierunku i krótkie uzasadnienie)

## Następne kroki
(3–5 konkretnych zadań w formacie GitHub/Obsidian checkboxów \`- [ ] ...\`, zwięzłych i wykonalnych)`;

  let response: Awaited<ReturnType<typeof ai.models.generateContent>>;
  let grounded = true;

  try {
    response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        tools: [{ googleSearch: {} }],
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[researchAgent] Google Search grounding failed (${message}); retrying without grounding tool.`,
    );
    grounded = false;
    response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
  }

  const rawText = response.text?.trim() ?? "";
  if (!rawText) {
    throw new Error("Gemini researcher returned an empty response");
  }

  const reportMarkdown = stripLeadingFrontmatterAndH1(rawText);
  const { sources, searchQueries } = grounded
    ? extractGroundingData(response)
    : { sources: [], searchQueries: [] };

  const summary = extractSummaryFromReport(reportMarkdown, params.topicTitle);

  return {
    title: params.topicTitle,
    summary,
    reportMarkdown,
    sources,
    searchQueries,
    grounded,
  };
}

export function renderResearchReportMarkdown(params: {
  topicTitle: string;
  topicSlug: string;
  updatedAtIso: string;
  extraTags?: readonly string[];
  generated: GeneratedResearchReport;
  sourcePath?: string;
  targetWikiPath?: string;
  branchName: string;
}): string {
  const tags = normalizeTagsList(params.extraTags);
  const title = `Research: ${params.topicTitle}`;
  const slug = `pomysly/${params.topicSlug}/research`;
  const cleanBody = stripLeadingFrontmatterAndH1(params.generated.reportMarkdown);

  const relatedSlug = params.targetWikiPath
    ? params.targetWikiPath
        .trim()
        .replace(/\\/g, "/")
        .replace(/^vault\//i, "")
        .replace(/^wiki\//i, "")
        .replace(/\.md$/i, "")
    : undefined;

  const lines: string[] = [
    "---",
    `title: ${escapeYaml(title)}`,
    `slug: ${slug}`,
    `updated_at: ${params.updatedAtIso}`,
    `tags: [${tags.join(", ")}]`,
    `summary: ${escapeYaml(params.generated.summary)}`,
    `grounded: ${params.generated.grounded ? "true" : "false"}`,
    "---",
    "",
    `# ${title}`,
    "",
  ];

  if (relatedSlug) {
    lines.push(`Powiązane: [[${relatedSlug}]]`, "");
  }

  lines.push(cleanBody, "", "## Źródła");
  if (params.generated.sources.length > 0) {
    for (const src of params.generated.sources) {
      lines.push(`- [${src.title}](${src.uri})`);
    }
  } else {
    lines.push("- Brak zewnętrznych linków z Google Search grounding dla tego uruchomienia.");
  }

  if (params.generated.searchQueries.length > 0) {
    lines.push(
      "",
      `Zapytania wyszukiwania: ${params.generated.searchQueries.map((q) => `\`${q}\``).join(", ")}`,
    );
  }

  lines.push("", "## Metadane analizy");
  if (params.sourcePath) {
    lines.push(`- Notatka źródłowa: \`${params.sourcePath}\``);
  }
  lines.push(`- Gałąź PR: \`${params.branchName}\``, "");

  return lines.join("\n");
}

export function renderPullRequestBody(params: {
  topicTitle: string;
  reportRepoPath: string;
  sourcePath?: string;
  targetWikiPath?: string;
  generated: GeneratedResearchReport;
}): string {
  const lines: string[] = [
    `## Research pomysłu: ${params.topicTitle}`,
    "",
    params.generated.summary,
    "",
    "### Co zawiera ten Pull Request",
    `- Nowy raport Markdown: \`${params.reportRepoPath}\``,
    `- Google Search grounding: **${params.generated.grounded ? "aktywny" : "fallback (bez narzędzia)"}** (${params.generated.sources.length} źródeł)`,
  ];

  if (params.sourcePath) {
    lines.push(`- Surowe źródło: \`${params.sourcePath}\``);
  }
  if (params.targetWikiPath) {
    lines.push(`- Powiązana notatka w wiki: \`${params.targetWikiPath}\``);
  }

  if (params.generated.sources.length > 0) {
    lines.push("", "### Wybrane źródła");
    for (const src of params.generated.sources.slice(0, 6)) {
      lines.push(`- [${src.title}](${src.uri})`);
    }
  }

  lines.push(
    "",
    "---",
    "Po kliknięciu **Merge pull request** webhook GitHuba automatycznie zsynchronizuje raport oraz zadania `- [ ]` do Firestore/Wiki.",
  );

  return lines.join("\n");
}

function formatBranchSuffix(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 16).replace(":", "")}`;
}

export async function runResearchAgent(params: {
  topicTitle: string;
  noteMarkdown: string;
  sourcePath?: string;
  targetWikiPath?: string;
  extraTags?: readonly string[];
  vaultClient: GitHubVaultClient;
  generateReport?: GenerateResearchReportFn;
  vaultPrefix?: string;
  now?: () => Date;
  force?: boolean;
}): Promise<ResearchRunResult> {
  const getNow = params.now ?? (() => new Date());
  const nowDate = getNow();
  const updatedAtIso = nowDate.toISOString().replace(/\.\d{3}Z$/, "Z");
  const noteDate = updatedAtIso.slice(0, 10);
  const generateReport = params.generateReport ?? generateResearchReportWithGemini;

  const { topicSlug, reportRelativePath, branchName } = buildResearchPaths({
    topicTitle: params.topicTitle,
    targetWikiPath: params.targetWikiPath
      ? extractVaultRelativePath(params.targetWikiPath, params.vaultPrefix) ?? params.targetWikiPath
      : undefined,
  });

  if (!params.force) {
    const existingPr = await params.vaultClient.findOpenPullRequest(branchName);
    if (existingPr) {
      return {
        status: "skipped",
        topicSlug,
        branch: existingPr.branch,
        reportPath: joinRepoPath(params.vaultPrefix, reportRelativePath),
        prNumber: existingPr.number,
        prUrl: existingPr.url,
        reason: "open_pr_already_exists",
      };
    }
  }

  const generated = await generateReport({
    topicTitle: params.topicTitle,
    noteMarkdown: params.noteMarkdown,
    targetWikiPath: params.targetWikiPath,
    noteDate,
  });

  const reportRepoPath = joinRepoPath(params.vaultPrefix, reportRelativePath);

  let activeBranch = branchName;
  try {
    await params.vaultClient.createBranch({ branchName: activeBranch });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 422) {
      activeBranch = `${branchName}-${formatBranchSuffix(nowDate)}`;
      await params.vaultClient.createBranch({ branchName: activeBranch });
    } else {
      throw err;
    }
  }

  const reportMarkdown = renderResearchReportMarkdown({
    topicTitle: params.topicTitle,
    topicSlug,
    updatedAtIso,
    extraTags: params.extraTags,
    generated,
    sourcePath: params.sourcePath,
    targetWikiPath: params.targetWikiPath,
    branchName: activeBranch,
  });

  const commitRes = await params.vaultClient.commitAtomicChanges({
    branch: activeBranch,
    commitMessage: `agent(researcher): ${params.topicTitle}`,
    changes: [{ path: reportRepoPath, content: reportMarkdown }],
  });

  const prBody = renderPullRequestBody({
    topicTitle: params.topicTitle,
    reportRepoPath,
    sourcePath: params.sourcePath,
    targetWikiPath: params.targetWikiPath,
    generated,
  });

  const pr = await params.vaultClient.createPullRequest({
    title: `Research: ${params.topicTitle}`,
    body: prBody,
    head: activeBranch,
  });

  return {
    status: "created",
    topicSlug,
    branch: activeBranch,
    reportPath: reportRepoPath,
    prNumber: pr.number,
    prUrl: pr.url,
    commitSha: commitRes.commitSha,
    sourcesCount: generated.sources.length,
    grounded: generated.grounded,
  };
}
