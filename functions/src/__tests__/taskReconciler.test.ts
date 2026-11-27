import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../app.js";
import { createInMemoryVaultStore } from "../services/firestoreStore.js";
import type { GitHubVaultClient } from "../services/github.js";
import type { GoogleTaskItem, GoogleWorkspaceClient } from "../services/googleWorkspace.js";
import { organizeInboxFile, type OrganizerDecision } from "../services/inboxOrganizer.js";
import {
  findDeterministicClosures,
  isReconcilableWikiPath,
  matchCompletedGoogleTasks,
  runTaskReconcilerAgent,
} from "../services/taskReconciler.js";

function signPayload(body: string, secret: string): string {
  const hex = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${hex}`;
}

function createMockVault(initialFiles: Record<string, string>): {
  client: GitHubVaultClient;
  files: Map<string, string>;
  commits: string[];
} {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const commits: string[] = [];

  const client: GitHubVaultClient = {
    async listTree() {
      return Array.from(files.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, content]) => ({
          path,
          sha: crypto.createHash("sha1").update(content).digest("hex"),
          type: "blob" as const,
        }));
    },
    async fetchFile(filePath: string) {
      return files.get(filePath) ?? null;
    },
    async commitAtomicChanges({ commitMessage, changes }) {
      commits.push(commitMessage);
      for (const ch of changes) {
        if (ch.content === null) files.delete(ch.path);
        else files.set(ch.path, ch.content);
      }
      return {
        commitSha: `rec-sha-${commits.length}`,
        treeSha: `rec-tree-${commits.length}`,
        branch: "main",
      };
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

  return { client, files, commits };
}

function createMockGoogle(completedTasks: GoogleTaskItem[]): GoogleWorkspaceClient {
  return {
    isConfigured: () => true,
    async listTaskLists() {
      return [{ id: "@default", title: "Moje zadania" }];
    },
    async listTasks() {
      return completedTasks;
    },
    async ensureTaskList(listName: string) {
      return { id: listName, title: listName, created: false };
    },
    async createTask(params) {
      return { id: "t-1", title: params.title };
    },
    async createCalendarEvent(params) {
      return { id: "e-1", summary: params.summary };
    },
  };
}

test("findDeterministicClosures closes parent research task and same-page duplicate of completed task", () => {
  const files = new Map<string, string>([
    [
      "wiki/pomysly/wyjazd.md",
      [
        "---",
        "title: Wyjazd",
        "---",
        "",
        "## Zadania",
        "- [ ] Zrobić research hoteli nad morzem",
        "- [ ] Spakować walizkę",
      ].join("\n"),
    ],
    [
      "wiki/obszary/dom/zakupy.md",
      [
        "---",
        "title: Zakupy",
        "---",
        "",
        "- [x] Kupić mleko",
        "- [ ] Kupić mleko @due(2026-11-28) #dom",
      ].join("\n"),
    ],
  ]);

  const allWiki = [
    "wiki/pomysly/wyjazd.md",
    "wiki/pomysly/wyjazd/research.md",
    "wiki/obszary/dom/zakupy.md",
  ];

  const closures = findDeterministicClosures(files, allWiki);
  assert.equal(closures.length, 2);
  assert.deepEqual(
    closures.map((c) => `${c.relPath}:${c.text}`).sort(),
    [
      "wiki/obszary/dom/zakupy.md:Kupić mleko",
      "wiki/pomysly/wyjazd.md:Zrobić research hoteli nad morzem",
    ],
  );
  assert.equal(isReconcilableWikiPath("wiki/projekty/foxie-notes/notatki.md"), true);
  assert.equal(isReconcilableWikiPath("wiki/projekty/foxie-notes/status.md"), false);
  assert.equal(isReconcilableWikiPath("wiki/projekty/foxie-notes/zadania/etap-3.md"), false);
});

test("matchCompletedGoogleTasks matches completed Google Tasks against open vault tasks", () => {
  const matches = matchCompletedGoogleTasks(
    [
      {
        sourcePath: "wiki/obszary/auto/toyota.md",
        repoPath: "wiki/obszary/auto/toyota.md",
        text: "Zadzwonić do Toyota Carter Gdańsk o 15:00 — tel. +48 58 340 22 22",
      },
      {
        sourcePath: "wiki/dziennik/2026-11-27.md",
        repoPath: "wiki/dziennik/2026-11-27.md",
        text: "Zadzwonić do rodziców w weekend",
      },
    ],
    [
      {
        id: "gt-1",
        title: "Zadzwonić do Toyota Carter Gdańsk w sprawie przeglądu",
        status: "completed",
        listId: "@default",
        listTitle: "Moje zadania",
      },
      {
        id: "gt-2",
        title: "Zadzwonić do rodziców w weekend",
        status: "needsAction",
        listId: "@default",
        listTitle: "Moje zadania",
      },
    ],
  );

  assert.equal(matches.length, 1);
  assert.equal(matches[0].relPath, "wiki/obszary/auto/toyota.md");
  assert.equal(matches[0].via, "google-tasks");
});

test("runTaskReconcilerAgent enforces confidence/path guardrails, updates log+Firestore, and skips LLM when unchanged", async () => {
  const { client, files, commits } = createMockVault({
    "wiki/log.md": "---\ntitle: Log\nslug: log\n---\n\n# Log zmian\n",
    "wiki/projekty/foxie-notes/status.md":
      "---\ntitle: Status\n---\n\nWdrożono ikonę sync 1/5 i limit 120s.\n",
    "wiki/projekty/foxie-notes/zadania/etap-3.md":
      "- [x] Wydłużono nagrywanie do 120s\n- [ ] Dodać sygnał dźwiękowy beep\n",
    "wiki/projekty/foxie-notes/notatki.md": [
      "---",
      "title: Notatki Foxie Notes",
      "slug: projekty/foxie-notes/notatki",
      "---",
      "",
      "## Zadania",
      "- [ ] Dodać ikonę synchronizacji 1/5",
      "- [ ] Dodać sygnał dźwiękowy beep ES8311",
    ].join("\n"),
    "wiki/obszary/dom/zakupy.md":
      "---\ntitle: Zakupy\n---\n\n- [ ] Pójść do sklepu po zakupy\n",
  });

  const store = createInMemoryVaultStore();
  let llmCalls = 0;
  const mockMatch = async () => {
    llmCalls++;
    return {
      summary: "Zamknięto wdrożoną ikonę sync 1/5.",
      closures: [
        {
          sourcePath: "wiki/projekty/foxie-notes/notatki.md",
          text: "Dodać ikonę synchronizacji 1/5",
          confidence: 0.96,
          reason: "Potwierdzone w status.md",
        },
        // Low confidence -> must be rejected
        {
          sourcePath: "wiki/projekty/foxie-notes/notatki.md",
          text: "Dodać sygnał dźwiękowy beep ES8311",
          confidence: 0.6,
          reason: "Niska pewność",
        },
        // Protected path -> must be rejected
        {
          sourcePath: "wiki/projekty/foxie-notes/zadania/etap-3.md",
          text: "Dodać sygnał dźwiękowy beep",
          confidence: 0.99,
          reason: "Ścieżka chroniona",
        },
      ],
    };
  };

  const googleClient = createMockGoogle([
    {
      id: "gt-99",
      title: "Pójść do sklepu po zakupy",
      status: "completed",
      listId: "@default",
      listTitle: "Zakupy",
    },
  ]);

  const res = await runTaskReconcilerAgent({
    vaultClient: client,
    store,
    googleClient,
    matchCompletedTasks: mockMatch,
    now: () => new Date("2026-11-27T14:00:00Z"),
  });

  assert.equal(res.status, "executed");
  assert.equal(res.closedTasks.length, 2);
  assert.equal(llmCalls, 1);
  assert.equal(commits.length, 1);
  assert.match(commits[0], /^agent\(reconciler\): closed 2 completed task/);

  // Both notatki.md and zakupy.md updated, protected etap-3.md untouched
  assert.match(
    files.get("wiki/projekty/foxie-notes/notatki.md") ?? "",
    /- \[x\] Dodać ikonę synchronizacji 1\/5/,
  );
  assert.match(
    files.get("wiki/projekty/foxie-notes/notatki.md") ?? "",
    /- \[ \] Dodać sygnał dźwiękowy beep ES8311/,
  );
  assert.match(
    files.get("wiki/obszary/dom/zakupy.md") ?? "",
    /- \[x\] Pójść do sklepu po zakupy/,
  );
  assert.match(
    files.get("wiki/log.md") ?? "",
    /\*\*Agent Reconciler \(`reconciler`\):\*\*/,
  );

  // Store has only 1 remaining open task (beep ES8311)
  const remainingOpen = await store.listOpenTasks();
  assert.equal(remainingOpen.length, 1);
  assert.equal(remainingOpen[0].text, "Dodać sygnał dźwiękowy beep ES8311");

  // Second run with skipLlmIfUnchanged skips LLM call
  const second = await runTaskReconcilerAgent({
    vaultClient: client,
    store,
    googleClient: createMockGoogle([]),
    matchCompletedTasks: mockMatch,
    skipLlmIfUnchanged: true,
    now: () => new Date("2026-11-27T15:00:00Z"),
  });
  assert.equal(second.status, "skipped");
  assert.equal(llmCalls, 1);
});

test("organizeInboxFile auto-closes cross-file open tasks mentioned as done in voice note", async () => {
  const { client, files } = createMockVault({
    "SCHEMA.md": "# SCHEMA",
    "wiki/index.md": "---\ntitle: Spis\nslug: index\n---\n\n# Spis\n",
    "wiki/log.md": "---\ntitle: Log\nslug: log\n---\n\n# Log\n",
    "wiki/obszary/dom/zakupy.md": [
      "---",
      "title: Zakupy domowe",
      "slug: obszary/dom/zakupy",
      "---",
      "",
      "# Zakupy domowe",
      "",
      "## Zadania",
      "- [ ] Pójść do sklepu po zakupy na obiad #dom",
    ].join("\n"),
    "raw/inbox/2026-11-27T14-10-00Z-waveshare-154-zakupy.md": [
      "---",
      "created_at: 2026-11-27T14:10:00Z",
      "source: waveshare-154",
      "---",
      "",
      "# Zakupy zrobione",
      "Byłem właśnie w sklepie i zrobiłem zakupy na obiad.",
    ].join("\n"),
  });

  const store = createInMemoryVaultStore();
  await store.replaceTasksForSource("wiki/obszary/dom/zakupy.md", [
    {
      id: "task-zakupy",
      text: "Pójść do sklepu po zakupy na obiad",
      completed: false,
      sourcePath: "wiki/obszary/dom/zakupy.md",
      sourceSlug: "obszary/dom/zakupy",
      updatedAt: "2026-11-27T10:00:00Z",
    },
  ]);

  let receivedOpenTaskCount = 0;
  const mockClassify = async (input: {
    openTasks?: Array<{ sourcePath: string; text: string }>;
  }): Promise<OrganizerDecision> => {
    receivedOpenTaskCount = input.openTasks?.length ?? 0;
    return {
      intent: "journal",
      targetPath: "wiki/dziennik/2026-11-27.md",
      title: "Dziennik 2026-11-27",
      summary: "Zakupy na obiad zrobione.",
      tags: ["dziennik", "dom"],
      relatedLinks: ["obszary/dom/zakupy"],
      sectionHeading: "Zakupy zrobione",
      contentMarkdown: "Byłem w sklepie i kupiłem składniki na obiad.",
      tasks: [],
      completedTaskRefs: [
        {
          sourcePath: "wiki/obszary/dom/zakupy.md",
          text: "Pójść do sklepu po zakupy na obiad",
          reason: "Użytkownik potwierdził zrobienie zakupów",
        },
      ],
      indexSection: "Dziennik",
      indexDescription: "Notatka z 2026-11-27.",
      logEntry: "Dodano wpis o zakupach do dziennika",
    };
  };

  const res = await organizeInboxFile({
    inboxRepoPath: "raw/inbox/2026-11-27T14-10-00Z-waveshare-154-zakupy.md",
    vaultClient: client,
    store,
    classifyNote: mockClassify,
    enablePlanningAgent: false,
    enableResearchAgent: false,
    now: () => new Date("2026-11-27T14:15:00Z"),
  });

  assert.equal(res.status, "processed");
  assert.equal(receivedOpenTaskCount, 1);
  assert.match(
    files.get("wiki/obszary/dom/zakupy.md") ?? "",
    /- \[x\] Pójść do sklepu po zakupy na obiad #dom/,
  );
  assert.match(
    files.get("wiki/log.md") ?? "",
    /automatycznie zamknięto 1 powiązanych zadań/,
  );
  assert.equal((await store.listOpenTasks()).length, 0);
});

test("GitHub docs(vault): webhook push triggers taskReconciler automatically without looping and POST /api/agents/reconcile-tasks works", async () => {
  process.env.DEVICE_API_KEY = "test-device-key";
  process.env.GITHUB_WEBHOOK_SECRET = "hook-secret";
  process.env.GITHUB_BRANCH = "main";
  process.env.GITHUB_VAULT_PREFIX = "";

  const { client, files } = createMockVault({
    "wiki/index.md": "---\ntitle: Spis\nslug: index\n---\n\n# Spis\n",
    "wiki/log.md": "---\ntitle: Log\nslug: log\n---\n\n# Log\n",
    "wiki/projekty/foxie-notes/status.md":
      "---\ntitle: Status\n---\n\nWdrożono sygnał beep na ES8311.\n",
    "wiki/projekty/foxie-notes/notatki.md":
      "---\ntitle: Notatki\n---\n\n- [ ] Dodać sygnał dźwiękowy beep\n",
  });

  const store = createInMemoryVaultStore();
  let matchCalls = 0;

  const app = createApp({
    now: () => new Date("2026-11-27T14:30:00Z"),
    vaultStore: store,
    fetchVaultFile: (p) => client.fetchFile(p),
    vaultClient: client,
    googleClient: createMockGoogle([]),
    matchCompletedTasks: async () => {
      matchCalls++;
      return {
        summary: "Zamknięto zadanie beep na podstawie docs(vault) sync.",
        closures: [
          {
            sourcePath: "wiki/projekty/foxie-notes/notatki.md",
            text: "Dodać sygnał dźwiękowy beep",
            confidence: 0.95,
            reason: "Wdrożono w commicie docs(vault)",
          },
        ],
      };
    },
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Webhook push from docs(vault): modifying status.md -> auto-triggers reconciler
    const syncPushBody = JSON.stringify({
      ref: "refs/heads/main",
      after: "sync-commit-1",
      commits: [
        {
          message: "docs(vault): sync Foxie Notes | commits: feat(firmware): add ES8311 beep",
          modified: ["wiki/projekty/foxie-notes/status.md"],
        },
      ],
    });
    const hookRes = await fetch(`${baseUrl}/api/webhook/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": signPayload(syncPushBody, "hook-secret"),
      },
      body: syncPushBody,
    });
    assert.equal(hookRes.status, 200);
    const hookJson = (await hookRes.json()) as {
      reconciled?: { status: string; closedTasks: Array<{ text: string }> };
    };
    assert.equal(hookJson.reconciled?.status, "executed");
    assert.equal(hookJson.reconciled?.closedTasks.length, 1);
    assert.equal(matchCalls, 1);
    assert.match(
      files.get("wiki/projekty/foxie-notes/notatki.md") ?? "",
      /- \[x\] Dodać sygnał dźwiękowy beep/,
    );

    // 2. Push containing agent(reconciler): MUST NOT re-trigger reconciler (anti-loop)
    const loopPushBody = JSON.stringify({
      ref: "refs/heads/main",
      after: "rec-commit-1",
      commits: [
        {
          message: "docs(vault): side commit",
          modified: ["wiki/projekty/foxie-notes/status.md"],
        },
        {
          message: "agent(reconciler): closed 1 completed task(s)",
          modified: ["wiki/projekty/foxie-notes/notatki.md"],
        },
      ],
    });
    const loopRes = await fetch(`${baseUrl}/api/webhook/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": signPayload(loopPushBody, "hook-secret"),
      },
      body: loopPushBody,
    });
    assert.equal(loopRes.status, 200);
    const loopJson = (await loopRes.json()) as { reconciled?: unknown };
    assert.equal(loopJson.reconciled, undefined);
    assert.equal(matchCalls, 1);

    // 3. POST /api/agents/reconcile-tasks endpoint works with auth
    const unauth = await fetch(`${baseUrl}/api/agents/reconcile-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(unauth.status, 401);

    const manualRes = await fetch(`${baseUrl}/api/agents/reconcile-tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "test-device-key",
      },
      body: JSON.stringify({ skipLlm: true, skipGoogle: true }),
    });
    assert.equal(manualRes.status, 200);
    const manualJson = (await manualRes.json()) as { ok: boolean; status: string };
    assert.equal(manualJson.ok, true);
    assert.equal(manualJson.status, "skipped");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
