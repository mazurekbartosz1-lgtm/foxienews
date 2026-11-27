#!/usr/bin/env node
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

function joinRemotePath(prefix, relPosixPath) {
  const trimmedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  return trimmedPrefix ? `${trimmedPrefix}/${relPosixPath}` : relPosixPath;
}

function stripPrefix(repoPath, prefix) {
  const cleanPath = repoPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const trimmedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  if (!trimmedPrefix) return cleanPath;
  const prefixWithSlash = `${trimmedPrefix}/`;
  return cleanPath.startsWith(prefixWithSlash)
    ? cleanPath.slice(prefixWithSlash.length)
    : null;
}

async function githubRequest(token, apiPath) {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "foxie-notes-vault-overview",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API GET ${apiPath} -> ${res.status}: ${text}`);
  }
  return res.json();
}

function parseMeta(markdown) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  const fmText = fmMatch ? fmMatch[1] : "";
  const body = fmMatch ? normalized.slice(fmMatch[0].length) : normalized;

  const extractField = (key) => {
    const m = fmText.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, "m"));
    if (!m) return "";
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  };

  const titleMatch = body.match(/^\s*#\s+(.+)$/m);
  const title = extractField("title") || (titleMatch ? titleMatch[1].trim() : "");
  const summary = extractField("summary");

  const openTasks = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*[-*]\s+\[\s\]\s+(.+)$/);
    if (m) {
      openTasks.push(m[1].trim());
    }
  }

  return { title, summary, openTasks };
}

function parseIndexSlugs(indexMarkdown) {
  const slugs = new Set();
  const regex = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let match;
  while ((match = regex.exec(indexMarkdown)) !== null) {
    const raw = match[1].trim().replace(/^\/+/, "").replace(/\.md$/i, "");
    if (raw) {
      slugs.add(raw.toLowerCase());
    }
  }
  return slugs;
}

function isLocalFoxieDoc(relPath) {
  return (
    relPath === "wiki/projekty/foxie-notes/status.md" ||
    relPath === "wiki/projekty/foxie-notes/index.md" ||
    relPath === "wiki/projekty/foxie-notes/sprzet-waveshare-v2.md" ||
    relPath.startsWith("wiki/projekty/foxie-notes/zadania/")
  );
}

async function fetchBlobText(token, owner, repo, sha) {
  const data = await githubRequest(token, `/repos/${owner}/${repo}/git/blobs/${sha}`);
  return Buffer.from(data.content, "base64").toString("utf8");
}

async function main() {
  loadEnvFile(path.join(ROOT_DIR, "functions", ".env"));
  loadEnvFile(path.join(ROOT_DIR, "functions", ".secret.local"));

  const token = process.env.GITHUB_TOKEN?.trim() ?? "";
  const owner = process.env.GITHUB_OWNER?.trim() ?? "";
  const repo = process.env.GITHUB_REPO?.trim() ?? "";
  const branch = process.env.GITHUB_BRANCH?.trim() || "main";
  const vaultPrefix = process.env.GITHUB_VAULT_PREFIX?.trim() ?? "";

  if (!token || !owner || !repo) {
    console.error(
      "[vault-overview] Missing GITHUB_TOKEN, GITHUB_OWNER, or GITHUB_REPO.",
    );
    process.exit(1);
  }

  const encodedBranch = branch
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");

  const refData = await githubRequest(
    token,
    `/repos/${owner}/${repo}/git/ref/heads/${encodedBranch}`,
  );
  const commitData = await githubRequest(
    token,
    `/repos/${owner}/${repo}/git/commits/${refData.object.sha}`,
  );
  const treeData = await githubRequest(
    token,
    `/repos/${owner}/${repo}/git/trees/${commitData.tree.sha}?recursive=1`,
  );

  const files = [];
  for (const item of treeData.tree ?? []) {
    if (item.type !== "blob" || !item.path || !item.sha) continue;
    const rel = stripPrefix(item.path, vaultPrefix);
    if (!rel) continue;
    files.push({ repoPath: item.path, rel, sha: item.sha });
  }

  const relSet = new Set(files.map((f) => f.rel));
  const inboxFiles = files.filter(
    (f) => f.rel.startsWith("raw/inbox/") && /\.md$/i.test(f.rel),
  );
  const projectFiles = files.filter(
    (f) =>
      f.rel.startsWith("wiki/projekty/") &&
      /\.md$/i.test(f.rel) &&
      !isLocalFoxieDoc(f.rel),
  );
  const ideaFiles = files.filter(
    (f) =>
      f.rel.startsWith("wiki/pomysly/") &&
      /\.md$/i.test(f.rel) &&
      !/\/research\.md$/i.test(f.rel),
  );
  const areaAndResourceFiles = files.filter(
    (f) =>
      (f.rel.startsWith("wiki/obszary/") || f.rel.startsWith("wiki/zasoby/")) &&
      /\.md$/i.test(f.rel),
  );
  const indexEntry = files.find((f) => f.rel === "wiki/index.md");

  const toFetch = [
    ...(indexEntry ? [indexEntry] : []),
    ...inboxFiles,
    ...projectFiles,
    ...ideaFiles,
    ...areaAndResourceFiles,
  ];

  const textByRel = new Map();
  await Promise.all(
    toFetch.map(async (f) => {
      const txt = await fetchBlobText(token, owner, repo, f.sha);
      textByRel.set(f.rel, txt);
    }),
  );

  console.log(`=== VAULT OVERVIEW: ${owner}/${repo}@${branch} (${files.length} files) ===\n`);

  // 1. raw/inbox/
  if (inboxFiles.length > 0) {
    console.log(`[WARNING] raw/inbox/ (${inboxFiles.length} nieprzetworzonych plików!):`);
    for (const f of inboxFiles) {
      const meta = parseMeta(textByRel.get(f.rel) ?? "");
      console.log(`  - ${f.rel}${meta.summary ? ` — ${meta.summary}` : ""}`);
      for (const task of meta.openTasks) {
        console.log(`      [ ] ${task}`);
      }
    }
  } else {
    console.log("raw/inbox/: 0 plików (czysty inbox)");
  }

  // 2. wiki/projekty/
  console.log(`\nwiki/projekty/ (zdalne / spoza lokalnych docs foxie-notes: ${projectFiles.length}):`);
  if (projectFiles.length === 0) {
    console.log("  (brak)");
  } else {
    for (const f of projectFiles) {
      const meta = parseMeta(textByRel.get(f.rel) ?? "");
      const slug = f.rel.replace(/^wiki\//i, "").replace(/\.md$/i, "");
      console.log(`  - ${slug}${meta.title ? ` (${meta.title})` : ""}`);
      if (meta.summary) console.log(`      ${meta.summary}`);
      for (const task of meta.openTasks) {
        console.log(`      [ ] ${task}`);
      }
    }
  }

  // 3. wiki/pomysly/
  console.log(`\nwiki/pomysly/ (${ideaFiles.length}):`);
  if (ideaFiles.length === 0) {
    console.log("  (brak)");
  } else {
    for (const f of ideaFiles) {
      const meta = parseMeta(textByRel.get(f.rel) ?? "");
      const slug = f.rel.replace(/^wiki\//i, "").replace(/\.md$/i, "");
      const researchRel = `wiki/${slug}/research.md`;
      const hasResearch = relSet.has(researchRel);
      console.log(
        `  - ${slug} [research.md: ${hasResearch ? "TAK" : "NIE"}]${meta.title ? ` — ${meta.title}` : ""}`,
      );
      if (meta.summary) console.log(`      ${meta.summary}`);
      for (const task of meta.openTasks) {
        console.log(`      [ ] ${task}`);
      }
    }
  }

  // 4. wiki/obszary/ & wiki/zasoby/
  console.log(`\nwiki/obszary/ & wiki/zasoby/ (${areaAndResourceFiles.length}):`);
  if (areaAndResourceFiles.length === 0) {
    console.log("  (brak)");
  } else {
    for (const f of areaAndResourceFiles) {
      const meta = parseMeta(textByRel.get(f.rel) ?? "");
      const slug = f.rel.replace(/^wiki\//i, "").replace(/\.md$/i, "");
      console.log(
        `  - ${slug} (otwarte zadania: ${meta.openTasks.length})${meta.summary ? ` — ${meta.summary}` : ""}`,
      );
      for (const task of meta.openTasks) {
        console.log(`      [ ] ${task}`);
      }
    }
  }

  // 5. Index integrity check
  const indexText = indexEntry ? textByRel.get(indexEntry.rel) ?? "" : "";
  const indexedSlugs = parseIndexSlugs(indexText);
  const missingFromIndex = files
    .filter(
      (f) =>
        f.rel.startsWith("wiki/") &&
        /\.md$/i.test(f.rel) &&
        f.rel !== "wiki/index.md" &&
        f.rel !== "wiki/log.md" &&
        !/\/research\.md$/i.test(f.rel),
    )
    .filter((f) => {
      const slug = f.rel.replace(/^wiki\//i, "").replace(/\.md$/i, "").toLowerCase();
      return !indexedSlugs.has(slug);
    });

  console.log(`\nIndex integrity check (${joinRemotePath(vaultPrefix, "wiki/index.md")}):`);
  if (missingFromIndex.length === 0) {
    console.log("  OK — wszystkie strony wiki/ są w wiki/index.md (0 brakujących).");
  } else {
    console.log(`  [WARNING] Brakujące strony w wiki/index.md (${missingFromIndex.length}):`);
    for (const f of missingFromIndex) {
      console.log(`    - ${f.rel}`);
    }
  }
}

main().catch((err) => {
  console.error("[vault-overview] ERROR:", err.message || err);
  process.exit(1);
});
