import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../app.js";
import { createInMemoryVaultStore } from "../services/firestoreStore.js";
import type { AtomicFileChange, GitHubVaultClient } from "../services/github.js";
import type { GoogleWorkspaceClient } from "../services/googleWorkspace.js";
import type { OrganizerDecision } from "../services/inboxOrganizer.js";
import { runPlanningAgent, type PlanningDecision } from "../services/planningAgent.js";

function signPayload(body: string, secret: string): string {
  const hex = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${hex}`;
}

function createPlanningMockClients(initialFiles: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const commits: Array<{ message: string; changes: AtomicFileChange[] }> = [];
  const taskLists: Array<{ id: string; title: string }> = [
    { id: "@default", title: "Moje zadania" },
  ];
  const createdTasks: Array<{ listId: string; id: string; title: string; dueDate?: string }> = [];
  const createdEvents: Array<{ id: string; summary: string; startIso: string; endIso: string }> = [];
  let seq = 1;

  const vaultClient: GitHubVaultClient = {
    async listTree() {
      return Array.from(files.keys())
        .sort()
        .map((path) => ({ path, sha: `blob-${path}`, type: "blob" as const }));
    },
    async fetchFile(path: string) {
      return files.get(path) ?? null;
    },
    async commitAtomicChanges({ changes, commitMessage, branch = "main" }) {
      for (const change of changes) {
        if (change.content === null) files.delete(change.path);
        else files.set(change.path, change.content);
      }
      commits.push({ message: commitMessage, changes });
      return { commitSha: `commit-${seq++}`, treeSha: `tree-${seq}`, branch };
    },
    async createBranch({ branchName }) {
      return `branch-${branchName}`;
    },
    async findOpenPullRequest() {
      return null;
    },
    async createPullRequest({ title, head }) {
      return { number: 1, url: `https://example.com/${title}`, branch: head };
    },
  };

  const googleClient: GoogleWorkspaceClient = {
    isConfigured() {
      return true;
    },
    async listTaskLists() {
      return [...taskLists];
    },
    async ensureTaskList(listName: string) {
      const existing = taskLists.find(
        (l) => l.title.toLowerCase() === listName.trim().toLowerCase(),
      );
      if (existing) return { ...existing, created: false };
      const created = { id: `list-${seq++}`, title: listName.trim() };
      taskLists.push(created);
      return { ...created, created: true };
    },
    async createTask(params) {
      const id = `task-${seq++}`;
      createdTasks.push({
        listId: params.listId,
        id,
        title: params.title,
        dueDate: params.dueDate,
      });
      return { id, title: params.title };
    },
    async createCalendarEvent(params) {
      const id = `ev-${seq++}`;
      createdEvents.push({
        id,
        summary: params.summary,
        startIso: params.startIso,
        endIso: params.endIso,
      });
      return {
        id,
        summary: params.summary,
        htmlLink: `https://calendar.google.com/event?eid=${id}`,
      };
    },
  };

  return { files, commits, taskLists, createdTasks, createdEvents, vaultClient, googleClient };
}

test("runPlanningAgent skips safely when Google OAuth2 is not configured", async () => {
  const unconfigured: GoogleWorkspaceClient = {
    isConfigured: () => false,
    listTaskLists: async () => [],
    ensureTaskList: async (name) => ({ id: "1", title: name, created: true }),
    createTask: async (p) => ({ id: "1", title: p.title }),
    createCalendarEvent: async (p) => ({ id: "1", summary: p.summary }),
  };

  const res = await runPlanningAgent({
    topicTitle: "Zakupy",
    noteMarkdown: "Kupić mleko",
    googleClient: unconfigured,
  });

  assert.equal(res.status, "skipped");
  assert.equal(res.reason, "google_oauth_not_configured");
});

test("Webhook plan-calendar -> Organizer -> Planning agent creates Calendar event, Task, Google Shopping List, and updates wiki", async () => {
  process.env.DEVICE_API_KEY = "test-device-key";
  process.env.GITHUB_WEBHOOK_SECRET = "hook-secret";
  process.env.GITHUB_BRANCH = "main";
  process.env.GITHUB_VAULT_PREFIX = "";

  const inboxPath = "raw/inbox/2026-11-26T19-00-00Z-waveshare-154-zakupy-w-srode.md";
  const mock = createPlanningMockClients({
    "SCHEMA.md": "# SCHEMA",
    "wiki/index.md": "---\ntitle: Spis treści\nslug: index\n---\n\n# Spis treści\n\n## System\n- [[log|Log]]\n",
    "wiki/log.md": "---\ntitle: Log\nslug: log\n---\n\n# Log\n",
    [inboxPath]: [
      "---",
      "created_at: 2026-11-26T19:00:00Z",
      "source: waveshare-154",
      "type: voice-note",
      "tags: [inbox, zakupy, dom]",
      "---",
      "",
      "# Zakupy w środę o 12:00",
      "",
      "W środę o 12:00 jadę na zakupy: kupić mleko, chleb i kawę ziarnistą, a wcześniej sprawdzić godziny otwarcia sklepu.",
    ].join("\n"),
  });

  const store = createInMemoryVaultStore();

  const mockClassify = async (): Promise<OrganizerDecision> => ({
    intent: "plan-calendar",
    targetPath: "wiki/obszary/dom/zakupy.md",
    title: "Zakupy domowe",
    summary: "Wyjazd na zakupy w środę o 12:00 z listą produktów.",
    tags: ["dom", "zakupy"],
    relatedLinks: [],
    sectionHeading: "Zakupy w środę",
    contentMarkdown: "Wyjazd na zakupy w środę o 12:00.",
    tasks: ["Sprawdzić godziny otwarcia sklepu @due(2026-12-01) #dom"],
    indexSection: "Obszary",
    indexDescription: "Bieżące zakupy i lista produktów.",
    logEntry: "Dodano plan zakupów w środę do wiki/obszary/dom/zakupy.md",
  });

  const mockPlan = async (): Promise<PlanningDecision> => ({
    calendarEvents: [
      {
        summary: "Zakupy spożywcze",
        description: "Mleko, chleb, kawa",
        startIso: "2026-12-02T12:00:00+01:00",
        confidence: 0.92,
      },
      {
        summary: "Może kiedyś odwiedzić market budowlany",
        startIso: "2026-12-03T10:00:00+01:00",
        confidence: 0.4, // below 0.75 threshold -> must be skipped
      },
    ],
    tasks: [
      {
        title: "Sprawdzić godziny otwarcia sklepu",
        dueDate: "2026-12-01",
      },
    ],
    listItems: [
      { listName: "Lista zakupów", title: "Mleko" },
      { listName: "Lista zakupów", title: "Chleb" },
      { listName: "Lista zakupów", title: "Kawa ziarnista" },
    ],
  });

  const app = createApp({
    now: () => new Date("2026-11-26T19:05:00Z"),
    vaultStore: store,
    fetchVaultFile: (p) => mock.vaultClient.fetchFile(p),
    vaultClient: mock.vaultClient,
    classifyInboxNote: mockClassify,
    googleClient: mock.googleClient,
    extractPlan: mockPlan,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const pushBody = JSON.stringify({
      ref: "refs/heads/main",
      after: "user-commit-plan",
      commits: [{ message: "capture(waveshare-154): Zakupy w środę", added: [inboxPath] }],
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
    const hookJson = (await hookRes.json()) as {
      organized?: Array<{
        status: string;
        intent: string;
        planning?: {
          status: string;
          calendarEventsCreated: Array<{ summary: string }>;
          tasksCreated: Array<{ title: string; listName: string }>;
          listItemsCreated: Array<{ title: string; listName: string }>;
          skippedLowConfidenceEvents?: number;
        };
      }>;
    };

    const plan = hookJson.organized?.[0].planning;
    assert.equal(plan?.status, "synced");
    assert.equal(plan?.calendarEventsCreated.length, 1);
    assert.equal(plan?.calendarEventsCreated[0].summary, "Zakupy spożywcze");
    assert.equal(plan?.skippedLowConfidenceEvents, 1);
    assert.equal(plan?.tasksCreated.length, 1);
    assert.equal(plan?.tasksCreated[0].listName, "Moje zadania");
    assert.equal(plan?.listItemsCreated.length, 3);
    assert.equal(plan?.listItemsCreated[0].listName, "Lista zakupów");

    // Verify endIso defaulted to +60 min and Lista zakupów was created once
    assert.equal(mock.createdEvents.length, 1);
    assert.equal(mock.taskLists.filter((l) => l.title === "Lista zakupów").length, 1);

    // Verify ## Synchronizacja Google was committed with agent(planner): prefix
    const plannerCommit = mock.commits.find((c) => c.message.startsWith("agent(planner):"));
    assert.ok(plannerCommit);
    const wikiMd = mock.files.get("wiki/obszary/dom/zakupy.md") ?? "";
    assert.match(wikiMd, /## Synchronizacja Google/);
    assert.match(wikiMd, /Google Lista \(Lista zakupów\): \*\*Mleko\*\*/);

    // Verify inbox_jobs stores Google IDs for idempotency
    const jobs = store.getAllInboxJobs();
    assert.equal(jobs[0].planningStatus, "synced");
    assert.equal(jobs[0].googleEventIds?.length, 1);
    assert.equal(jobs[0].googleTaskIds?.length, 4);
    assert.deepEqual(jobs[0].googleListsUsed, ["Moje zadania", "Lista zakupów"]);

    // Verify POST /api/agents/plan auth + validation + execution
    const unauth = await fetch(`${baseUrl}/api/agents/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Kupić masło" }),
    });
    assert.equal(unauth.status, 401);

    const bad = await fetch(`${baseUrl}/api/agents/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "test-device-key" },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);

    const manualRes = await fetch(`${baseUrl}/api/agents/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "test-device-key" },
      body: JSON.stringify({ text: "W środę o 12:00 zakupy: mleko, chleb" }),
    });
    assert.equal(manualRes.status, 200);
    const manualJson = (await manualRes.json()) as { ok: boolean; status: string };
    assert.equal(manualJson.ok, true);
    assert.equal(manualJson.status, "synced");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
