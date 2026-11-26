import type { CaptureSource } from "../types/api.js";

const POLISH_CHAR_MAP: Record<string, string> = {
  ą: "a",
  ć: "c",
  ę: "e",
  ł: "l",
  ń: "n",
  ó: "o",
  ś: "s",
  ź: "z",
  ż: "z",
  Ą: "a",
  Ć: "c",
  Ę: "e",
  Ł: "l",
  Ń: "n",
  Ó: "o",
  Ś: "s",
  Ź: "z",
  Ż: "z",
};

export function slugifyPolish(input: string): string {
  const transliterated = input
    .split("")
    .map((ch) => POLISH_CHAR_MAP[ch] ?? ch)
    .join("");

  const slug = transliterated
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

  return slug || "notatka";
}

export function formatTimestampForFilename(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
}

export function buildInboxPath(params: {
  createdAt: Date;
  source: CaptureSource;
  title: string;
  vaultPrefix?: string;
  inboxDir?: string;
}): string {
  const stamp = formatTimestampForFilename(params.createdAt);
  const slug = slugifyPolish(params.title);
  const cleanInboxDir =
    (params.inboxDir ?? "raw/inbox")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "") || "raw/inbox";
  const relative = `${cleanInboxDir}/${stamp}-${params.source}-${slug}.md`;
  const prefix = (params.vaultPrefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${relative}` : relative;
}

function escapeYamlString(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, " ").trim());
}

export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>(["inbox"]);
  for (const raw of tags) {
    const cleaned = slugifyPolish(raw.replace(/^#/, ""));
    if (cleaned && cleaned !== "notatka") {
      seen.add(cleaned);
    } else if (raw.replace(/^#/, "").trim().toLowerCase() === "notatka") {
      seen.add("notatka");
    }
  }
  return Array.from(seen);
}

export function buildCaptureMarkdown(params: {
  createdAt: Date;
  source: CaptureSource;
  type: "voice-note" | "text-note";
  title: string;
  summary: string;
  body: string;
  tags: readonly string[];
  tasks: readonly string[];
}): string {
  const createdIso = params.createdAt.toISOString().replace(/\.\d{3}Z$/, "Z");
  const normalizedTags = normalizeTags(params.tags);
  const cleanTitle = params.title.trim() || "Notatka";
  const cleanSummary = params.summary.trim() || cleanTitle;
  const cleanBody = params.body.trim();

  const lines: string[] = [
    "---",
    `created_at: ${createdIso}`,
    `source: ${params.source}`,
    `type: ${params.type}`,
    `tags: [${normalizedTags.join(", ")}]`,
    `summary: ${escapeYamlString(cleanSummary)}`,
    "---",
    "",
    `# ${cleanTitle}`,
    "",
  ];

  if (cleanBody) {
    lines.push(cleanBody, "");
  }

  const cleanTasks = params.tasks
    .map((task) => task.replace(/^- \[[ xX]\]\s*/, "").trim())
    .filter(Boolean);

  if (cleanTasks.length > 0) {
    lines.push("## Zadania");
    for (const task of cleanTasks) {
      lines.push(`- [ ] ${task}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
