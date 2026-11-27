import crypto from "node:crypto";
import type { TaskDoc, WikiPageDoc } from "../types/api.js";

export interface ParsedFrontmatter {
  title?: string;
  slug?: string;
  updatedAt?: string;
  summary?: string;
  tags: string[];
}

const HIGH_PRIORITY_TAGS = new Set(["priorytet", "high", "p0", "p1", "urgent"]);
const MEDIUM_PRIORITY_TAGS = new Set(["medium", "p2"]);
const LOW_PRIORITY_TAGS = new Set(["low", "p3"]);

export function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.md$/i, "");
}

export function slugToDocId(slug: string): string {
  const normalized = normalizeSlug(slug);
  return normalized.replace(/\//g, "__") || "index";
}

function unquoteYaml(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed) as string;
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineTags(raw: string): string[] {
  const inner = raw.trim().replace(/^\[|\]$/g, "");
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((item) => unquoteYaml(item).replace(/^#/, "").trim())
    .filter(Boolean);
}

export function parseFrontmatter(markdown: string): {
  frontmatter: ParsedFrontmatter;
  body: string;
} {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return {
      frontmatter: { tags: [] },
      body: normalized,
    };
  }

  const rawBlock = match[1];
  const body = normalized.slice(match[0].length);
  const fm: ParsedFrontmatter = { tags: [] };
  const lines = rawBlock.split("\n");
  let readingTagsList = false;

  for (const line of lines) {
    if (readingTagsList) {
      const listMatch = line.match(/^\s*-\s+(.+)$/);
      if (listMatch) {
        const tag = unquoteYaml(listMatch[1]).replace(/^#/, "").trim();
        if (tag) fm.tags.push(tag);
        continue;
      }
      readingTagsList = false;
    }

    const kvMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1].toLowerCase();
    const rawVal = kvMatch[2].trim();

    if (key === "tags") {
      if (!rawVal) {
        readingTagsList = true;
      } else {
        fm.tags.push(...parseInlineTags(rawVal));
      }
    } else if (key === "title") {
      const val = unquoteYaml(rawVal);
      if (val) fm.title = val;
    } else if (key === "slug") {
      const val = normalizeSlug(unquoteYaml(rawVal));
      if (val) fm.slug = val;
    } else if (key === "updated_at" || key === "updatedat") {
      const val = unquoteYaml(rawVal);
      if (val) fm.updatedAt = val;
    } else if (key === "summary") {
      const val = unquoteYaml(rawVal);
      if (val) fm.summary = val;
    }
  }

  fm.tags = Array.from(new Set(fm.tags));
  return { frontmatter: fm, body };
}

export function markdownToPlainText(markdown: string, maxLength?: number): string {
  const { body } = parseFrontmatter(markdown);
  const lines = body.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      if (trimmed) out.push(trimmed);
      continue;
    }

    // Drop pure horizontal rules
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      continue;
    }

    let line = rawLine
      // Images ![alt](url) -> alt
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      // Links [text](url) -> text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Wikilinks [[slug|label]] -> label, [[slug]] -> slug
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      // Inline code
      .replace(/`([^`]+)`/g, "$1")
      // Headings and blockquotes
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      // Task checkboxes -> compact e-ink friendly form
      .replace(/^(\s*)[-*]\s+\[([ xX])\]\s+/, (_, indent: string, check: string) =>
        `${indent}[${check.toLowerCase() === "x" ? "x" : " "}] `,
      )
      // Emphasis
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      .trimEnd();

    if (line.trim() === "" && (out.length === 0 || out[out.length - 1] === "")) {
      continue;
    }
    out.push(line);
  }

  const joined = out.join("\n").trim();
  if (maxLength && joined.length > maxLength) {
    return `${joined.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
  }
  return joined;
}

function inferPriority(tags: readonly string[]): string | undefined {
  for (const t of tags) {
    if (HIGH_PRIORITY_TAGS.has(t)) return "high";
  }
  for (const t of tags) {
    if (MEDIUM_PRIORITY_TAGS.has(t)) return "medium";
  }
  for (const t of tags) {
    if (LOW_PRIORITY_TAGS.has(t)) return "low";
  }
  return undefined;
}

export function cleanTaskLineText(rawText: string): {
  cleanText: string;
  dueDate?: string;
  tags: string[];
} {
  let text = rawText.trim();

  let dueDate: string | undefined;
  const dueMatch = text.match(/@due\((\d{4}-\d{2}-\d{2})\)/i);
  if (dueMatch) {
    dueDate = dueMatch[1];
    text = text.replace(/@due\(\d{4}-\d{2}-\d{2}\)/gi, " ");
  }

  const foundTags: string[] = [];
  text = text.replace(
    /(^|\s)#([A-Za-z0-9_ąćęłńóśźżĄĆĘŁŃÓŚŹŻ][A-Za-z0-9_\-ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]*)/g,
    (_full, prefix: string, tag: string) => {
      foundTags.push(tag.toLowerCase());
      return prefix;
    },
  );

  const cleanText = text.replace(/\s+/g, " ").trim();
  const tags = Array.from(new Set(foundTags));
  return { cleanText, dueDate, tags };
}

export function extractTasksFromMarkdown(params: {
  markdown: string;
  sourcePath: string;
  sourceSlug?: string;
  updatedAt: string;
}): TaskDoc[] {
  const { body } = parseFrontmatter(params.markdown);
  const lines = body.split("\n");
  const tasks: TaskDoc[] = [];
  const occurrenceCounter = new Map<string, number>();
  let inCodeBlock = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (!match) continue;

    const completed = match[1].toLowerCase() === "x";
    const { cleanText, dueDate, tags } = cleanTaskLineText(match[2]);
    if (!cleanText) continue;

    const priority = inferPriority(tags);

    const occKey = `${completed ? "1" : "0"}:${cleanText}`;
    const occIndex = occurrenceCounter.get(occKey) ?? 0;
    occurrenceCounter.set(occKey, occIndex + 1);

    const id = crypto
      .createHash("sha1")
      .update(`${params.sourcePath}\n${occIndex}\n${cleanText}`)
      .digest("hex")
      .slice(0, 16);

    const doc: TaskDoc = {
      id,
      text: cleanText,
      completed,
      sourcePath: params.sourcePath,
      updatedAt: params.updatedAt,
    };
    if (params.sourceSlug) doc.sourceSlug = params.sourceSlug;
    if (dueDate) doc.dueDate = dueDate;
    if (priority) doc.priority = priority;
    if (tags.length > 0) doc.tags = tags;

    tasks.push(doc);
  }

  return tasks;
}

export function toggleTaskInMarkdown(params: {
  markdown: string;
  targetText: string;
  completed: boolean;
  updatedAtIso?: string;
}): { markdown: string; found: boolean; changed: boolean } {
  const normalized = params.markdown.replace(/\r\n/g, "\n");
  const target = params.targetText.replace(/\s+/g, " ").trim();
  const fmMatch = normalized.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
  const fmBlock = fmMatch ? fmMatch[0] : "";
  const body = fmMatch ? normalized.slice(fmBlock.length) : normalized;

  const lines = body.split("\n");
  let inCodeBlock = false;
  let firstMatchingDiffIndex = -1;
  let firstMatchingSameIndex = -1;

  const parsedLines = lines.map((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeBlock = !inCodeBlock;
      return null;
    }
    if (inCodeBlock) return null;

    const match = line.match(/^(\s*[-*]\s+\[)([ xX])(\]\s+)(.+)$/);
    if (!match) return null;

    const { cleanText } = cleanTaskLineText(match[4]);
    if (cleanText !== target) return null;

    const currentlyCompleted = match[2].toLowerCase() === "x";
    if (currentlyCompleted !== params.completed) {
      if (firstMatchingDiffIndex === -1) firstMatchingDiffIndex = index;
    } else if (firstMatchingSameIndex === -1) {
      firstMatchingSameIndex = index;
    }

    return match;
  });

  if (firstMatchingDiffIndex === -1 && firstMatchingSameIndex === -1) {
    return { markdown: normalized, found: false, changed: false };
  }

  if (firstMatchingDiffIndex === -1) {
    return { markdown: normalized, found: true, changed: false };
  }

  const matched = parsedLines[firstMatchingDiffIndex]!;
  lines[firstMatchingDiffIndex] =
    `${matched[1]}${params.completed ? "x" : " "}${matched[3]}${matched[4]}`;

  let nextFm = fmBlock;
  if (nextFm && params.updatedAtIso && /^updated_at:/im.test(nextFm)) {
    nextFm = nextFm.replace(/^updated_at:.*$/im, `updated_at: ${params.updatedAtIso}`);
  }

  return {
    markdown: `${nextFm}${lines.join("\n")}`,
    found: true,
    changed: true,
  };
}

function extractFirstHeading(body: string): string | undefined {
  const match = body.match(/^\s*#\s+(.+)$/m);
  return match ? match[1].trim() : undefined;
}

function deriveSummary(frontmatter: ParsedFrontmatter, plainText: string, title: string): string {
  if (frontmatter.summary) return frontmatter.summary;
  const lines = plainText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== title);
  const first = lines[0] ?? title;
  return first.length > 180 ? `${first.slice(0, 179).trimEnd()}…` : first;
}

export function buildWikiPageDoc(params: {
  path: string;
  relativePath: string;
  markdown: string;
  updatedAt: string;
}): WikiPageDoc {
  const { frontmatter, body } = parseFrontmatter(params.markdown);
  const pathSlug = normalizeSlug(params.relativePath.replace(/^wiki\//i, ""));
  const slug = frontmatter.slug || pathSlug;
  const title = frontmatter.title || extractFirstHeading(body) || slug.split("/").pop() || slug;
  const plainText = markdownToPlainText(params.markdown);
  const summary = deriveSummary(frontmatter, plainText, title);

  return {
    slug,
    title,
    path: params.path,
    markdown: params.markdown.replace(/\r\n/g, "\n"),
    plainText,
    summary,
    tags: frontmatter.tags,
    updatedAt: frontmatter.updatedAt || params.updatedAt,
  };
}

export function parseWikiIndexDescriptions(indexMarkdown: string): Map<string, string> {
  const descriptions = new Map<string, string>();
  const { body } = parseFrontmatter(indexMarkdown);

  for (const line of body.split("\n")) {
    const match = line.match(/^\s*[-*]\s+\[\[([^\]]+)\]\]\s*(?:—|--|-|:)\s*(.+)$/);
    if (!match) continue;

    const targetRaw = match[1].split("|")[0];
    const slug = normalizeSlug(targetRaw);
    const desc = match[2]
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();

    if (slug && desc) {
      descriptions.set(slug, desc);
    }
  }

  return descriptions;
}
