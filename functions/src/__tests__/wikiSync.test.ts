import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../app.js";
import { createInMemoryVaultStore } from "../services/firestoreStore.js";
import type { GitHubVaultClient } from "../services/github.js";
import {
  extractTasksFromMarkdown,
  markdownToPlainText,
  parseFrontmatter,
  toggleTaskInMarkdown,
} from "../services/wikiParser.js";
import { verifyGitHubWebhookSignature } from "../services/wikiSync.js";

function signPayload(body: string, secret: string): string {
  const hex = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${hex}`;
}

test("parseFrontmatter parses inline and multiline tags and strips CRLF", () => {
  const md = [
    "---",
    'title: "Sprzęt Waveshare V2"',
    "slug: projekty/foxie-notes/sprzet-waveshare-v2",
    "updated_at: 2026-11-26T05:50:00Z",
    "tags:",
    "  - sprzet",
    "  - #esp32-s3",
    "---",
    "",
    "# Sprzęt Waveshare V2",
    "Treść główna.",
  ].join("\r\n");

  const parsed = parseFrontmatter(md);
  assert.equal(parsed.frontmatter.title, "Sprzęt Waveshare V2");
  assert.equal(parsed.frontmatter.slug, "projekty/foxie-notes/sprzet-waveshare-v2");
  assert.equal(parsed.frontmatter.updatedAt, "2026-11-26T05:50:00Z");
  assert.deepEqual(parsed.frontmatter.tags, ["sprzet", "esp32-s3"]);
  assert.match(parsed.body, /^# Sprzęt Waveshare V2/m);
});

test("markdownToPlainText strips formatting, wikilinks, and fences for e-ink", () => {
  const md = [
    "---",
    "title: Test",
    "---",
    "",
    "# Nagłówek główny",
    "",
    "Zobacz [[projekty/foxie-notes/status|status projektu]] oraz [[log]].",
    "To jest **ważna** i `szybka` [notatka](https://example.com).",
    "",
    "- [ ] Zadanie otwarte",
    "- [x] Zadanie ukończone",
    "",
    "```ts",
    "const x = 1;",
    "```",
  ].join("\n");

  const plain = markdownToPlainText(md);
  assert.doesNotMatch(plain, /---/);
  assert.doesNotMatch(plain, /\*\*/);
  assert.doesNotMatch(plain, /```/);
  assert.match(plain, /^Nagłówek główny/m);
  assert.match(plain, /Zobacz status projektu oraz log\./);
  assert.match(plain, /To jest ważna i szybka notatka\./);
  assert.match(plain, /^\[ \] Zadanie otwarte/m);
  assert.match(plain, /^\[x\] Zadanie ukończone/m);
});

test("extractTasksFromMarkdown parses checkboxes, @due, #tags, priority, and skips code blocks", () => {
  const md = [
    "# Zadania",
    "- [ ] Kupić baterię LiPo @due(2026-12-01) #sprzet #priorytet",
    "- [X] Skonfigurować I2C #firmware #low",
    "",
    "```markdown",
    "- [ ] To jest przykład w bloku kodu, nie prawdziwe zadanie",
    "```",
  ].join("\n");

  const tasks = extractTasksFromMarkdown({
    markdown: md,
    sourcePath: "vault/wiki/projekty/foxie-notes/zadania/etap-1.md",
    sourceSlug: "projekty/foxie-notes/zadania/etap-1",
    updatedAt: "2026-11-26T06:00:00Z",
  });

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].completed, false);
  assert.equal(tasks[0].text, "Kupić baterię LiPo");
  assert.equal(tasks[0].dueDate, "2026-12-01");
  assert.equal(tasks[0].priority, "high");
  assert.deepEqual(tasks[0].tags, ["sprzet", "priorytet"]);
  assert.equal(tasks[0].sourceSlug, "projekty/foxie-notes/zadania/etap-1");

  assert.equal(tasks[1].completed, true);
  assert.equal(tasks[1].text, "Skonfigurować I2C");
  assert.equal(tasks[1].priority, "low");
  assert.deepEqual(tasks[1].tags, ["firmware", "low"]);
});

test("verifyGitHubWebhookSignature validates HMAC-SHA256 safely", () => {
  const payload = Buffer.from('{"hello":"foxie"}', "utf8");
  const sig = signPayload('{"hello":"foxie"}', "top-secret");

  assert.equal(verifyGitHubWebhookSignature(payload, sig, "top-secret"), true);
  assert.equal(verifyGitHubWebhookSignature(payload, sig, "wrong-secret"), false);
  assert.equal(
    verifyGitHubWebhookSignature(Buffer.from('{"hello":"tampered"}'), sig, "top-secret"),
    false,
  );
  assert.equal(verifyGitHubWebhookSignature(payload, undefined, "top-secret"), false);
});

test("GitHub webhook syncs wiki pages, tasks, and serves GET /api/wiki/index & /api/wiki/page/*", async () => {
  process.env.DEVICE_API_KEY = "test-device-key";
  process.env.GITHUB_WEBHOOK_SECRET = "hook-secret";
  process.env.GITHUB_BRANCH = "main";
  process.env.GITHUB_VAULT_PREFIX = "vault";

  const files = new Map<string, string>([
    [
      "vault/wiki/index.md",
      [
        "---",
        "title: Spis treści",
        "slug: index",
        "---",
        "",
        "# Spis treści",
        "- [[projekty/foxie-notes/status|Status Foxie]] — Aktualny stan urządzenia i backendu",
      ].join("\n"),
    ],
    [
      "vault/wiki/projekty/foxie-notes/status.md",
      [
        "---",
        "title: Status Foxie",
        "slug: projekty/foxie-notes/status",
        "tags: [status, esp32]",
        "---",
        "",
        "Urządzenie **ESP32-S3** nagrywa WAV i wysyła do API.",
        "",
        "## Zadania",
        "- [ ] Przetestować E2E z kluczami @due(2026-12-05) #priorytet",
      ].join("\n"),
    ],
    [
      "vault/wiki/old-note.md",
      [
        "---",
        "title: Stara notatka",
        "---",
        "",
        "- [ ] Stare zadanie do usunięcia",
      ].join("\n"),
    ],
    [
      "vault/raw/inbox/2026-11-26-voice.md",
      [
        "---",
        "created_at: 2026-11-26T06:00:00Z",
        "source: waveshare-154",
        "---",
        "",
        "# Pomysł poranny",
        "- [ ] Kupić kawę ziarnistą #dom",
      ].join("\n"),
    ],
  ]);

  const store = createInMemoryVaultStore();
  const fixedNow = new Date("2026-11-26T06:10:00Z");

  const app = createApp({
    now: () => fixedNow,
    vaultStore: store,
    fetchVaultFile: async (path) => files.get(path) ?? null,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Invalid signature -> 401
    const badHook = await fetch(`${baseUrl}/api/webhook/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": "sha256=deadbeef",
      },
      body: JSON.stringify({ ref: "refs/heads/main", commits: [] }),
    });
    assert.equal(badHook.status, 401);

    // 2. Ping event -> 200
    const pingBody = JSON.stringify({ zen: "Keep it simple" });
    const pingRes = await fetch(`${baseUrl}/api/webhook/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-Hub-Signature-256": signPayload(pingBody, "hook-secret"),
      },
      body: pingBody,
    });
    assert.equal(pingRes.status, 200);

    // 3. Push on non-target branch -> ignored
    const otherBranchBody = JSON.stringify({
      ref: "refs/heads/feature-x",
      commits: [{ added: ["vault/wiki/old-note.md"] }],
    });
    const otherBranchRes = await fetch(`${baseUrl}/api/webhook/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": signPayload(otherBranchBody, "hook-secret"),
      },
      body: otherBranchBody,
    });
    assert.equal(otherBranchRes.status, 200);
    const otherJson = (await otherBranchRes.json()) as Record<string, unknown>;
    assert.equal(otherJson.ignored, true);

    // 4. First push adds 3 wiki pages and 1 inbox note
    const push1Body = JSON.stringify({
      ref: "refs/heads/main",
      after: "commit-1",
      commits: [
        {
          added: [
            "vault/wiki/index.md",
            "vault/wiki/projekty/foxie-notes/status.md",
            "vault/wiki/old-note.md",
            "vault/raw/inbox/2026-11-26-voice.md",
            "firmware/src/main.cpp",
          ],
        },
      ],
    });
    const push1Res = await fetch(`${baseUrl}/api/webhook/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": signPayload(push1Body, "hook-secret"),
      },
      body: push1Body,
    });
    assert.equal(push1Res.status, 200);
    const push1Json = (await push1Res.json()) as Record<string, unknown>;
    assert.equal(push1Json.syncedPages, 3);
    assert.equal(push1Json.syncedTaskSources, 4);
    assert.equal(push1Json.indexCount, 2); // excludes index itself
    assert.equal(store.getAllTasks().length, 3);

    // 5. Second push removes old-note.md and updates status.md
    files.delete("vault/wiki/old-note.md");
    const push2Body = JSON.stringify({
      ref: "refs/heads/main",
      after: "commit-2",
      commits: [
        {
          removed: ["vault/wiki/old-note.md"],
        },
      ],
    });
    const push2Res = await fetch(`${baseUrl}/api/webhook/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": signPayload(push2Body, "hook-secret"),
      },
      body: push2Body,
    });
    assert.equal(push2Res.status, 200);
    const push2Json = (await push2Res.json()) as Record<string, unknown>;
    assert.equal(push2Json.deletedPages, 1);
    assert.equal(push2Json.deletedTaskSources, 1);
    assert.equal(push2Json.indexCount, 1);
    assert.equal(store.getAllTasks().length, 2);

    // 6. GET /api/wiki/index requires auth and supports ?q=
    const unauthIndex = await fetch(`${baseUrl}/api/wiki/index`);
    assert.equal(unauthIndex.status, 401);

    const indexRes = await fetch(`${baseUrl}/api/wiki/index?q=esp32`, {
      headers: { "X-API-Key": "test-device-key" },
    });
    assert.equal(indexRes.status, 200);
    const indexJson = (await indexRes.json()) as {
      entries: Array<{ slug: string; summary: string }>;
    };
    assert.equal(indexJson.entries.length, 1);
    assert.equal(indexJson.entries[0].slug, "projekty/foxie-notes/status");
    assert.equal(
      indexJson.entries[0].summary,
      "Aktualny stan urządzenia i backendu",
    );

    // 7. GET /api/wiki/page/* supports nested slugs and ?format=plain
    const plainRes = await fetch(
      `${baseUrl}/api/wiki/page/projekty/foxie-notes/status?format=plain`,
      { headers: { "X-API-Key": "test-device-key" } },
    );
    assert.equal(plainRes.status, 200);
    const plainJson = (await plainRes.json()) as {
      slug: string;
      plainText: string;
      markdown?: string;
    };
    assert.equal(plainJson.slug, "projekty/foxie-notes/status");
    assert.equal(plainJson.markdown, undefined);
    assert.match(plainJson.plainText, /Urządzenie ESP32-S3 nagrywa WAV/);

    // 8. Deleted page returns 404
    const deletedPageRes = await fetch(`${baseUrl}/api/wiki/page/old-note`, {
      headers: { "X-API-Key": "test-device-key" },
    });
    assert.equal(deletedPageRes.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

test("toggleTaskInMarkdown toggles matching checkbox, preserves metadata, skips code blocks", () => {
  const md = [
    "---",
    "title: Zakupy",
    "updated_at: 2026-11-26T06:00:00Z",
    "---",
    "",
    "```markdown",
    "- [ ] Kupić mleko @due(2026-11-28) #dom",
    "```",
    "",
    "- [ ] Kupić mleko @due(2026-11-28) #dom",
    "- [x] Kupić chleb",
  ].join("\n");

  const doneRes = toggleTaskInMarkdown({
    markdown: md,
    targetText: "Kupić mleko",
    completed: true,
    updatedAtIso: "2026-11-27T12:00:00Z",
  });
  assert.equal(doneRes.found, true);
  assert.equal(doneRes.changed, true);
  assert.match(doneRes.markdown, /^updated_at: 2026-11-27T12:00:00Z/m);
  assert.match(
    doneRes.markdown,
    /```markdown\n- \[ \] Kupić mleko @due\(2026-11-28\) #dom\n```/,
  );
  assert.match(doneRes.markdown, /\n- \[x\] Kupić mleko @due\(2026-11-28\) #dom/);

  const reopenRes = toggleTaskInMarkdown({
    markdown: doneRes.markdown,
    targetText: "Kupić mleko",
    completed: false,
    updatedAtIso: "2026-11-27T12:05:00Z",
  });
  assert.equal(reopenRes.found, true);
  assert.equal(reopenRes.changed, true);
  assert.match(reopenRes.markdown, /\n- \[ \] Kupić mleko @due\(2026-11-28\) #dom/);

  const missing = toggleTaskInMarkdown({
    markdown: md,
    targetText: "Nieistniejące zadanie",
    completed: true,
  });
  assert.equal(missing.found, false);
  assert.equal(missing.changed, false);
});

test("syncGitHubPush excludes research.md tasks and POST /api/tasks/toggle updates vault + Firestore store", async () => {
  process.env.DEVICE_API_KEY = "test-device-key";
  process.env.GITHUB_WEBHOOK_SECRET = "hook-secret";
  process.env.GITHUB_BRANCH = "main";
  process.env.GITHUB_VAULT_PREFIX = "vault";

  const files = new Map<string, string>([
    [
      "vault/wiki/obszary/dom/zakupy.md",
      [
        "---",
        "title: Zakupy domowe",
        "slug: obszary/dom/zakupy",
        "updated_at: 2026-11-26T10:00:00Z",
        "---",
        "",
        "- [ ] Pójść do sklepu po zakupy @due(2026-11-28) #dom",
      ].join("\n"),
    ],
    [
      "vault/wiki/pomysly/wyjazd/research.md",
      [
        "---",
        "title: Research: Wyjazd",
        "slug: pomysly/wyjazd/research",
        "---",
        "",
        "- [ ] Sugestia z raportu, nie powinna trafić do zadań",
      ].join("\n"),
    ],
  ]);

  const store = createInMemoryVaultStore();
  // Seed a stale research.md task in store to confirm sync cleans it up
  await store.replaceTasksForSource("vault/wiki/pomysly/wyjazd/research.md", [
    {
      id: "stale-research-task",
      text: "Sugestia z raportu, nie powinna trafić do zadań",
      completed: false,
      sourcePath: "vault/wiki/pomysly/wyjazd/research.md",
      sourceSlug: "pomysly/wyjazd/research",
      updatedAt: "2026-11-26T09:00:00Z",
    },
  ]);

  const commits: string[] = [];
  const vaultClient: GitHubVaultClient = {
    async listTree() {
      return [];
    },
    async fetchFile(filePath) {
      return files.get(filePath) ?? null;
    },
    async commitAtomicChanges({ commitMessage, changes }) {
      commits.push(commitMessage);
      for (const ch of changes) {
        if (ch.content === null) files.delete(ch.path);
        else files.set(ch.path, ch.content);
      }
      return { commitSha: "toggle-sha-1", treeSha: "tree-1", branch: "main" };
    },
    async createBranch() {
      return "base-sha";
    },
    async findOpenPullRequest() {
      return null;
    },
    async createPullRequest() {
      return { number: 1, url: "https://example.test/pr/1", branch: "main" };
    },
  };

  const app = createApp({
    now: () => new Date("2026-11-27T13:00:00Z"),
    vaultStore: store,
    fetchVaultFile: async (p) => files.get(p) ?? null,
    vaultClient,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // Webhook push cleans stale research.md task and syncs zakupy.md task
    const pushBody = JSON.stringify({
      ref: "refs/heads/main",
      after: "c-sync",
      commits: [
        {
          modified: [
            "vault/wiki/obszary/dom/zakupy.md",
            "vault/wiki/pomysly/wyjazd/research.md",
          ],
        },
      ],
    });
    const hookRes = await fetch(`${baseUrl}/api/webhook/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": signPayload(pushBody, "hook-secret"),
      },
      body: pushBody,
    });
    assert.equal(hookRes.status, 200);
    const tasksAfterPush = store.getAllTasks();
    assert.equal(tasksAfterPush.length, 1);
    assert.equal(tasksAfterPush[0].sourceSlug, "obszary/dom/zakupy");
    assert.equal(tasksAfterPush[0].completed, false);

    // Unauthenticated toggle -> 401
    const unauth = await fetch(`${baseUrl}/api/tasks/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourcePath: "vault/wiki/obszary/dom/zakupy.md",
        text: "Pójść do sklepu po zakupy",
        completed: true,
      }),
    });
    assert.equal(unauth.status, 401);

    // Invalid sourcePath outside wiki/ -> 400
    const badPath = await fetch(`${baseUrl}/api/tasks/toggle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "test-device-key",
      },
      body: JSON.stringify({
        sourcePath: "vault/raw/inbox/note.md",
        text: "Pójść do sklepu po zakupy",
        completed: true,
      }),
    });
    assert.equal(badPath.status, 400);

    // Non-existent task -> 404
    const missingTask = await fetch(`${baseUrl}/api/tasks/toggle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "test-device-key",
      },
      body: JSON.stringify({
        sourcePath: "vault/wiki/obszary/dom/zakupy.md",
        text: "Nie ma takiego zadania",
        completed: true,
      }),
    });
    assert.equal(missingTask.status, 404);

    // Valid toggle -> 200, commits Markdown [x], updates Firestore store immediately
    const toggleRes = await fetch(`${baseUrl}/api/tasks/toggle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "test-device-key",
      },
      body: JSON.stringify({
        sourcePath: "vault/wiki/obszary/dom/zakupy.md",
        text: "Pójść do sklepu po zakupy",
        completed: true,
      }),
    });
    assert.equal(toggleRes.status, 200);
    const toggleJson = (await toggleRes.json()) as {
      ok: boolean;
      changed: boolean;
      completed: boolean;
      commitSha: string;
    };
    assert.equal(toggleJson.ok, true);
    assert.equal(toggleJson.changed, true);
    assert.equal(toggleJson.completed, true);
    assert.equal(toggleJson.commitSha, "toggle-sha-1");
    assert.equal(commits.length, 1);
    assert.match(commits[0], /^agent\(tasks\): done /);
    assert.match(
      files.get("vault/wiki/obszary/dom/zakupy.md") ?? "",
      /- \[x\] Pójść do sklepu po zakupy @due\(2026-11-28\) #dom/,
    );
    const tasksAfterToggle = store.getAllTasks();
    assert.equal(tasksAfterToggle.length, 1);
    assert.equal(tasksAfterToggle[0].completed, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
