import crypto from "node:crypto";
import type { WikiIndexEntry } from "../types/api.js";
import type { VaultStore } from "./firestoreStore.js";
import {
  buildWikiPageDoc,
  extractTasksFromMarkdown,
  normalizeSlug,
  parseWikiIndexDescriptions,
} from "./wikiParser.js";

export interface GitHubPushCommit {
  message?: string;
  added?: string[];
  modified?: string[];
  removed?: string[];
}

export interface GitHubPushPayload {
  ref?: string;
  after?: string;
  commits?: GitHubPushCommit[];
}

export interface SyncPushResult {
  syncedPages: number;
  deletedPages: number;
  syncedTaskSources: number;
  deletedTaskSources: number;
  indexCount: number;
}

export function verifyGitHubWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret || !signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expectedHex = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const expectedBuf = Buffer.from(`sha256=${expectedHex}`, "utf8");
  const receivedBuf = Buffer.from(signatureHeader.trim(), "utf8");

  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

export function extractVaultRelativePath(
  repoPath: string,
  vaultPrefix = "",
): string | null {
  const cleanPath = repoPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const cleanPrefix = vaultPrefix.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

  if (cleanPrefix) {
    const prefixWithSlash = `${cleanPrefix}/`;
    if (!cleanPath.startsWith(prefixWithSlash)) {
      return null;
    }
    return cleanPath.slice(prefixWithSlash.length);
  }
  return cleanPath;
}

function isVaultMarkdownFile(relativePath: string): boolean {
  if (!/\.md$/i.test(relativePath)) return false;
  return relativePath.startsWith("wiki/") || relativePath.startsWith("raw/inbox/");
}

export function isTaskSourceExcluded(relativePath: string): boolean {
  const clean = relativePath.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  return (
    clean === "wiki/index.md" ||
    clean === "wiki/log.md" ||
    /(^|\/)research\.md$/i.test(clean)
  );
}

function isAgentOrSyncCommitMessage(message: string | undefined): boolean {
  if (!message) return false;
  const trimmed = message.trim().toLowerCase();
  return trimmed.startsWith("agent(") || trimmed.startsWith("docs(vault):");
}

export function extractNewInboxFilesFromPush(
  payload: GitHubPushPayload,
  vaultPrefix = "",
): string[] {
  const candidates = new Set<string>();

  for (const commit of payload.commits ?? []) {
    if (isAgentOrSyncCommitMessage(commit.message)) {
      continue;
    }

    for (const p of commit.added ?? []) {
      const rel = extractVaultRelativePath(p, vaultPrefix);
      if (rel && rel.startsWith("raw/inbox/") && /\.md$/i.test(rel)) {
        candidates.add(p);
      }
    }
    for (const p of commit.removed ?? []) {
      candidates.delete(p);
    }
  }

  return Array.from(candidates).sort();
}

export async function syncGitHubPush(params: {
  payload: GitHubPushPayload;
  vaultPrefix?: string;
  store: VaultStore;
  fetchFile: (path: string, ref?: string) => Promise<string | null>;
  now?: () => Date;
}): Promise<SyncPushResult> {
  const getNow = params.now ?? (() => new Date());
  const updatedAt = getNow().toISOString().replace(/\.\d{3}Z$/, "Z");
  const ref = params.payload.after || undefined;

  // Replay commits in order so the final state of each path wins
  const fileOps = new Map<string, "upsert" | "delete">();
  for (const commit of params.payload.commits ?? []) {
    for (const p of commit.added ?? []) fileOps.set(p, "upsert");
    for (const p of commit.modified ?? []) fileOps.set(p, "upsert");
    for (const p of commit.removed ?? []) fileOps.set(p, "delete");
  }

  let syncedPages = 0;
  let deletedPages = 0;
  let syncedTaskSources = 0;
  let deletedTaskSources = 0;
  let wikiChanged = false;
  let indexDescriptions = new Map<string, string>();

  async function removePath(repoPath: string, relativePath: string): Promise<void> {
    await params.store.deleteTasksForSource(repoPath);
    deletedTaskSources++;

    if (relativePath.startsWith("wiki/")) {
      const slug = normalizeSlug(relativePath.replace(/^wiki\//i, ""));
      await params.store.deleteWikiPage(slug);
      deletedPages++;
      wikiChanged = true;
    }
  }

  for (const [repoPath, op] of fileOps.entries()) {
    const relativePath = extractVaultRelativePath(repoPath, params.vaultPrefix);
    if (!relativePath || !isVaultMarkdownFile(relativePath)) {
      continue;
    }

    if (op === "delete") {
      await removePath(repoPath, relativePath);
      continue;
    }

    const markdown = await params.fetchFile(repoPath, ref);
    if (markdown === null) {
      await removePath(repoPath, relativePath);
      continue;
    }

    let sourceSlug: string | undefined;
    if (relativePath.startsWith("wiki/")) {
      const page = buildWikiPageDoc({
        path: repoPath,
        relativePath,
        markdown,
        updatedAt,
      });
      sourceSlug = page.slug;
      await params.store.upsertWikiPage(page);
      syncedPages++;
      wikiChanged = true;

      if (page.slug === "index") {
        indexDescriptions = parseWikiIndexDescriptions(markdown);
      }
    }

    const tasks = isTaskSourceExcluded(relativePath)
      ? []
      : extractTasksFromMarkdown({
          markdown,
          sourcePath: repoPath,
          sourceSlug,
          updatedAt,
        });
    await params.store.replaceTasksForSource(repoPath, tasks);
    syncedTaskSources++;
  }

  let indexCount = 0;
  if (wikiChanged) {
    if (indexDescriptions.size === 0) {
      const existingIndexPage = await params.store.getWikiPage("index");
      if (existingIndexPage) {
        indexDescriptions = parseWikiIndexDescriptions(existingIndexPage.markdown);
      }
    }

    const pages = await params.store.listWikiPages();
    const entries: WikiIndexEntry[] = pages
      .filter((page) => page.slug !== "index")
      .map((page) => ({
        slug: page.slug,
        title: page.title,
        summary: indexDescriptions.get(page.slug) || page.summary || page.title,
        tags: page.tags,
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));

    await params.store.saveWikiIndex({
      entries,
      updatedAt,
    });
    indexCount = entries.length;
  } else {
    const currentIndex = await params.store.getWikiIndex();
    indexCount = currentIndex?.entries.length ?? 0;
  }

  return {
    syncedPages,
    deletedPages,
    syncedTaskSources,
    deletedTaskSources,
    indexCount,
  };
}
