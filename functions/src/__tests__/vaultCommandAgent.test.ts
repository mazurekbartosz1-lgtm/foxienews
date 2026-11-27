import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../app.js";
import { createInMemoryVaultStore } from "../services/firestoreStore.js";
import type {
  AtomicFileChange,
  GitHubVaultClient,
} from "../services/github.js";
import type { OrganizerDecision } from "../services/inboxOrganizer.js";
import {
  runVaultCommandAgent,
  sanitizeCuratorWikiPath,
} from "../services/vaultCommandAgent.js";

function signPayload(body: string, secret: string): string {
  const hex = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${hex}`;
}

function createCuratorMockVaultClient(initialFiles: Record<string, string>): {
  client: GitHubVaultClient;
  files: Map<string, string>;
  commits: Array<{ message: string; sha: string; changes: AtomicFileChange[] }>;
} {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const commits: Array<{ message: string; sha: string; changes: AtomicFileChange[] }> = [];
  let seq = 1;

  const client: GitHubVaultClient = {
    async listTree() {
      return Array.from(files.keys())
        .sort()
        .map((path) => ({ path, sha: `blob-${path}`, type: "blob" as const }));
    },
    async fetchFile(path: string) {
      return files.get(path) ?? null;
    },
    async commitAtomicChanges({ commitMessage, changes }) {
      for (const change of changes) {
        if (change.content === null) {
          files.delete(change.path);
        } else {
          files.set(change.path, change.content);
        }
      }
      const sha = `sha-curator-${seq++}`;
      commits.push({ message: commitMessage, sha, changes });
      return {
        commitSha: sha,
        treeSha: `tree-${seq}`,
        branch: "main",
      };
    },
    async createBranch() {
      return "sha-base";
    },
    async findOpenPullRequest() {
      return null;
    },
    async createPullRequest() {
      return { number: 1, url: "https://example.test/pr/1", branch: "main" };
    },
  };

  return { client, files, commits };
}

async function withServer(
  app: ReturnType<typeof createApp>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("sanitizeCuratorWikiPath allows PARA subfolders and blocks protected paths", () => {
  assert.equal(
    sanitizeCuratorWikiPath("wiki/obszary/Zdrowie/Samopoczucie.md"),
    "wiki/obszary/zdrowie/samopoczucie.md",
  );
  assert.equal(
    sanitizeCuratorWikiPath("vault/wiki/projekty/Dom/Remont łazienki.md", "vault"),
    "wiki/projekty/dom/remont-lazienki.md",
  );

  assert.equal(sanitizeCuratorWikiPath("wiki/index.md"), null);
  assert.equal(sanitizeCuratorWikiPath("wiki/log.md"), null);
  assert.equal(sanitizeCuratorWikiPath("SCHEMA.md"), null);
  assert.equal(sanitizeCuratorWikiPath("raw/inbox/note.md"), null);
  assert.equal(sanitizeCuratorWikiPath("wiki/projekty/foxie-notes/status.md"), null);
  assert.equal(sanitizeCuratorWikiPath("wiki/projekty/foxie-notes/index.md"), null);
  assert.equal(sanitizeCuratorWikiPath("../outside.md"), null);
});

test("runVaultCommandAgent writes safe subfolder wiki page, blocks protected writes, and updates index + log", async () => {
  const mock = createCuratorMockVaultClient({
    "SCHEMA.md": "# Schema\n",
    "wiki/index.md": `---
title: Spis treści
type: index
updated_at: 2026-11-26T10:00:00Z
---

# Spis treści

## Obszary

## Dziennik
- [[dziennik/2026-11-26|2026-11-26]] — Wpisy dnia.
`,
    "wiki/log.md": `---
title: Log zmian
type: index
updated_at: 2026-11-26T10:00:00Z
---

# Log zmian
`,
    "wiki/dziennik/2026-11-26.md": `---
title: "2026-11-26"
type: journal
updated_at: 2026-11-26T14:26:45Z
---

# 2026-11-26

## 14:26 — Samopoczucie po bieganiu
Zmęczenie po biegu 8 km, spadek energii wieczorem.
`,
    "wiki/projekty/foxie-notes/status.md": "CHRONIONY STATUS PROJEKTU",
  });

  const res = await runVaultCommandAgent({
    command: "Zrób folder zdrowie/samopoczucie i uporządkuj notatki o samopoczuciu",
    vaultClient: mock.client,
    now: () => new Date("2026-11-27T08:00:00Z"),
    selectFiles: async () => ["wiki/dziennik/2026-11-26.md"],
    buildPlan: async () => ({
      summary: "Utworzono stronę wiki/obszary/zdrowie/samopoczucie.md",
      writes: [
        {
          path: "wiki/obszary/zdrowie/samopoczucie.md",
          title: "Zdrowie i samopoczucie",
          description: "Notatki o zdrowiu, energii i regeneracji.",
          contentMarkdown: "# Zdrowie i samopoczucie\n\n## 2026-11-26\nZmęczenie po biegu 8 km.\n",
        },
        {
          path: "wiki/projekty/foxie-notes/status.md",
          title: "Hack attempt",
          description: "Should be blocked",
          contentMarkdown: "OVERWRITE ATTEMPT",
        },
      ],
      deletes: ["wiki/index.md"],
    }),
  });

  assert.equal(res.status, "executed");
  assert.deepEqual(res.filesWritten, ["wiki/obszary/zdrowie/samopoczucie.md"]);
  assert.deepEqual(res.filesDeleted, []);
  assert.equal(mock.files.get("wiki/projekty/foxie-notes/status.md"), "CHRONIONY STATUS PROJEKTU");

  const createdPage = mock.files.get("wiki/obszary/zdrowie/samopoczucie.md") ?? "";
  assert.match(createdPage, /^---\n/);
  assert.match(createdPage, /title: "Zdrowie i samopoczucie"/);

  const indexMd = mock.files.get("wiki/index.md") ?? "";
  assert.match(indexMd, /\[\[obszary\/zdrowie\/samopoczucie\|Zdrowie i samopoczucie\]\]/);

  const logMd = mock.files.get("wiki/log.md") ?? "";
  assert.match(logMd, /\*\*Agent Kurator \(`vault-command`\):\*\*/);
  assert.ok(mock.commits[0].message.startsWith("agent(curator):"));
});

test("webhook routes vault-command inbox note through Kurator without creating journal page", async () => {
  process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret-test";
  process.env.DEVICE_API_KEY = "dev-key-test";
  process.env.GITHUB_BRANCH = "main";
  process.env.GITHUB_VAULT_PREFIX = "";

  const inboxPath = "raw/inbox/2026-11-27T08-10-00Z-web-uporzadkuj-zdrowie.md";
  const mock = createCuratorMockVaultClient({
    "SCHEMA.md": "# Schema\n",
    "wiki/index.md": "# Spis treści\n\n## Obszary\n",
    "wiki/log.md": "# Log zmian\n",
    "wiki/dziennik/2026-11-26.md": "# 2026-11-26\n\n## Samopoczucie\nBól głowy rano.",
    [inboxPath]: `---
title: "Polecenie porządkowania"
source: web
created_at: 2026-11-27T08:10:00Z
---

Zrób folder zdrowie/samopoczucie i zbierz tam notatki o zdrowiu.
`,
  });

  const store = createInMemoryVaultStore();
  const app = createApp({
    vaultStore: store,
    fetchVaultFile: (p) => mock.client.fetchFile(p),
    vaultClient: mock.client,
    enableInboxOrganizer: true,
    classifyInboxNote: async (): Promise<OrganizerDecision> => ({
      intent: "vault-command",
      targetPath: "wiki/dziennik/2026-11-27.md",
      title: "Polecenie porządkowania",
      summary: "Polecenie reorganizacji zdrowie/samopoczucie",
      tags: ["organizacja"],
      relatedLinks: [],
      contentMarkdown: "IGNORED_FOR_COMMAND",
      tasks: [],
      indexSection: "Obszary",
      indexDescription: "",
      logEntry: "",
    }),
    selectVaultCommandFiles: async () => ["wiki/dziennik/2026-11-26.md"],
    buildVaultCommandPlan: async () => ({
      summary: "Wydzielono obszar zdrowie/samopoczucie",
      writes: [
        {
          path: "wiki/obszary/zdrowie/samopoczucie.md",
          title: "Zdrowie i samopoczucie",
          description: "Obszar zdrowia i samopoczuciu.",
          contentMarkdown: "---\ntitle: \"Zdrowie i samopoczucie\"\n---\n\n# Zdrowie i samopoczucie\n\nBól głowy rano (2026-11-26).\n",
        },
      ],
      deletes: [],
    }),
    now: () => new Date("2026-11-27T08:12:00Z"),
  });

  const payload = JSON.stringify({
    ref: "refs/heads/main",
    after: "push-sha-1",
    commits: [
      {
        id: "push-sha-1",
        message: "capture(web): polecenie porządkowania",
        added: [inboxPath],
        modified: [],
        removed: [],
      },
    ],
  });

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/webhook/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": signPayload(payload, "webhook-secret-test"),
      },
      body: payload,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      organized?: Array<{
        intent?: string;
        status: string;
        targetPath?: string;
        vaultCommand?: { status: string; filesWritten: string[] };
      }>;
    };
    assert.equal(body.organized?.[0]?.status, "processed");
    assert.equal(body.organized?.[0]?.intent, "vault-command");
    assert.equal(
      body.organized?.[0]?.targetPath,
      "wiki/obszary/zdrowie/samopoczucie.md",
    );
    assert.equal(body.organized?.[0]?.vaultCommand?.status, "executed");
  });

  assert.equal(mock.files.has(inboxPath), false);
  assert.equal(
    mock.files.has("raw/processed/2026-11/2026-11-27T08-10-00Z-web-uporzadkuj-zdrowie.md"),
    true,
  );
  assert.equal(mock.files.has("wiki/dziennik/2026-11-27.md"), false);
  assert.equal(mock.files.has("wiki/obszary/zdrowie/samopoczucie.md"), true);

  const job = await store.getInboxJob(inboxPath);
  assert.equal(job?.status, "done");
  assert.equal(job?.intent, "vault-command");
  assert.equal(job?.vaultCommandSummary, "Wydzielono obszar zdrowie/samopoczucie");
  assert.deepEqual(job?.vaultCommandFiles, ["wiki/obszary/zdrowie/samopoczucie.md"]);
});

test("POST /api/agents/vault-command enforces auth, validates input, and executes plan", async () => {
  process.env.DEVICE_API_KEY = "dev-key-test";

  const mock = createCuratorMockVaultClient({
    "SCHEMA.md": "# Schema\n",
    "wiki/index.md": "# Spis treści\n\n## Obszary\n",
    "wiki/log.md": "# Log zmian\n",
  });

  const app = createApp({
    vaultStore: createInMemoryVaultStore(),
    vaultClient: mock.client,
    selectVaultCommandFiles: async () => [],
    buildVaultCommandPlan: async () => ({
      summary: "Utworzono folder zdrowie/samopoczucie",
      writes: [
        {
          path: "wiki/obszary/zdrowie/samopoczucie.md",
          title: "Zdrowie i samopoczucie",
          description: "Start strony o zdrowiu i samopoczuciu.",
          contentMarkdown: "---\ntitle: \"Zdrowie i samopoczucie\"\n---\n\n# Zdrowie i samopoczucie\n",
        },
      ],
      deletes: [],
    }),
    now: () => new Date("2026-11-27T08:15:00Z"),
  });

  await withServer(app, async (baseUrl) => {
    const unauth = await fetch(`${baseUrl}/api/agents/vault-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "test" }),
    });
    assert.equal(unauth.status, 401);

    const badReq = await fetch(`${baseUrl}/api/agents/vault-command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "dev-key-test",
      },
      body: JSON.stringify({ command: "   " }),
    });
    assert.equal(badReq.status, 400);

    const okRes = await fetch(`${baseUrl}/api/agents/vault-command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "dev-key-test",
      },
      body: JSON.stringify({
        command: "Zrób folder zdrowie/samopoczucie i utwórz stronę wiki",
      }),
    });
    assert.equal(okRes.status, 200);
    const json = (await okRes.json()) as {
      ok: boolean;
      status: string;
      filesWritten: string[];
    };
    assert.equal(json.ok, true);
    assert.equal(json.status, "executed");
    assert.deepEqual(json.filesWritten, ["wiki/obszary/zdrowie/samopoczucie.md"]);
  });

  assert.equal(mock.files.has("wiki/obszary/zdrowie/samopoczucie.md"), true);
});
