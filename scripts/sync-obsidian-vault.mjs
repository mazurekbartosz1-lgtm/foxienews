#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = cleaned.indexOf("=");
    if (eq <= 0) continue;
    const key = cleaned.slice(0, eq).trim();
    let val = cleaned.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = val;
    }
  }
}

function collectFilesRecursively(dirPath) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursively(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function gitBlobSha1(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`, "utf8");
  return crypto.createHash("sha1").update(header).update(buf).digest("hex");
}

function joinRemotePath(prefix, relPosixPath) {
  const trimmedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  return trimmedPrefix ? `${trimmedPrefix}/${relPosixPath}` : relPosixPath;
}

async function githubRequest(token, apiPath, options = {}) {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "foxie-notes-vault-sync",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${options.method ?? "GET"} ${apiPath} -> ${res.status}: ${text}`);
  }
  return res.json();
}

async function main() {
  loadEnvFile(path.join(ROOT_DIR, "functions", ".env"));
  loadEnvFile(path.join(ROOT_DIR, "functions", ".secret.local"));

  const token = process.env.GITHUB_TOKEN?.trim() ?? "";
  const owner = process.env.GITHUB_OWNER?.trim() ?? "";
  const repo = process.env.GITHUB_REPO?.trim() ?? "";
  const branch = (process.env.GITHUB_BRANCH?.trim() || "main");
  const vaultPrefix = process.env.GITHUB_VAULT_PREFIX?.trim() ?? "";

  if (!token || !owner || !repo) {
    console.error(
      "[sync-vault] Missing GITHUB_TOKEN, GITHUB_OWNER, or GITHUB_REPO (check functions/.env and functions/.secret.local)."
    );
    process.exit(1);
  }

  let commitMessage = "docs(vault): sync Foxie Notes project history and wiki";
  const msgIdx = process.argv.indexOf("--message");
  if (msgIdx >= 0 && process.argv[msgIdx + 1]) {
    commitMessage = process.argv[msgIdx + 1];
  }
  const includeRootWiki = process.argv.includes("--include-root-wiki");

  const vaultDir = path.join(ROOT_DIR, "vault");
  const filesToSync = [];

  const schemaPath = path.join(vaultDir, "SCHEMA.md");
  if (fs.existsSync(schemaPath)) {
    filesToSync.push({
      localPath: schemaPath,
      remotePath: joinRemotePath(vaultPrefix, "SCHEMA.md"),
      protectedIfRemoteExists: false,
    });
  }

  const projectDir = path.join(vaultDir, "wiki", "projekty", "foxie-notes");
  for (const fullPath of collectFilesRecursively(projectDir)) {
    const relPosix = path
      .relative(vaultDir, fullPath)
      .split(path.sep)
      .join("/");
    filesToSync.push({
      localPath: fullPath,
      remotePath: joinRemotePath(vaultPrefix, relPosix),
      protectedIfRemoteExists: false,
    });
  }

  for (const rootWikiFile of ["index.md", "log.md"]) {
    const fullPath = path.join(vaultDir, "wiki", rootWikiFile);
    if (!fs.existsSync(fullPath)) continue;
    const relPosix = path
      .relative(vaultDir, fullPath)
      .split(path.sep)
      .join("/");
    filesToSync.push({
      localPath: fullPath,
      remotePath: joinRemotePath(vaultPrefix, relPosix),
      protectedIfRemoteExists: !includeRootWiki,
    });
  }

  if (filesToSync.length === 0) {
    console.log("[sync-vault] No vault/SCHEMA.md or vault/wiki files found.");
    return;
  }

  const encodedBranch = branch
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");

  const refData = await githubRequest(
    token,
    `/repos/${owner}/${repo}/git/ref/heads/${encodedBranch}`
  );
  const headCommitSha = refData.object.sha;

  const commitData = await githubRequest(
    token,
    `/repos/${owner}/${repo}/git/commits/${headCommitSha}`
  );
  const baseTreeSha = commitData.tree.sha;

  const treeData = await githubRequest(
    token,
    `/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`
  );
  const remoteShaByPath = new Map();
  for (const item of treeData.tree ?? []) {
    if (item.type === "blob" && item.path && item.sha) {
      remoteShaByPath.set(item.path, item.sha);
    }
  }

  const changedTreeEntries = [];
  const skippedProtected = [];
  for (const file of filesToSync) {
    if (file.protectedIfRemoteExists && remoteShaByPath.has(file.remotePath)) {
      skippedProtected.push(file.remotePath);
      continue;
    }

    const buf = fs.readFileSync(file.localPath);
    const localSha = gitBlobSha1(buf);
    if (remoteShaByPath.get(file.remotePath) === localSha) {
      continue;
    }

    const blob = await githubRequest(token, `/repos/${owner}/${repo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({
        content: buf.toString("base64"),
        encoding: "base64",
      }),
    });

    changedTreeEntries.push({
      path: file.remotePath,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
    });
  }

  if (skippedProtected.length > 0) {
    console.log(
      `[sync-vault] Preserved existing remote root wiki files: ${skippedProtected.join(", ")}`
    );
  }

  if (changedTreeEntries.length === 0) {
    console.log(
      `[sync-vault] Already up to date (${filesToSync.length} files checked in ${owner}/${repo}@${branch}).`
    );
    return;
  }

  const newTree = await githubRequest(token, `/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: changedTreeEntries,
    }),
  });

  const newCommit = await githubRequest(token, `/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: commitMessage,
      tree: newTree.sha,
      parents: [headCommitSha],
    }),
  });

  await githubRequest(
    token,
    `/repos/${owner}/${repo}/git/refs/heads/${encodedBranch}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        sha: newCommit.sha,
      }),
    }
  );

  console.log(
    `[sync-vault] Synced ${changedTreeEntries.length} file(s) -> ${owner}/${repo}@${branch} (${newCommit.sha.slice(0, 7)}):`
  );
  for (const entry of changedTreeEntries) {
    console.log(`  - ${entry.path}`);
  }
}

main().catch((err) => {
  console.error("[sync-vault] ERROR:", err.message || err);
  process.exit(1);
});
