import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../app.js";
import { createInMemoryVaultStore } from "../services/firestoreStore.js";
import { runGardenerAgent } from "../services/gardenerAgent.js";
import type { AtomicFileChange, GitHubVaultClient } from "../services/github.js";
import {
  getIsoWeekInfo,
  runWeeklyReviewAgent,
} from "../services/weeklyReviewAgent.js";

function createInMemoryGitHubVaultClient(initialFiles: Record<string, string>): {
  client: GitHubVaultClient;
  files: Map<string, string>;
  commits: Array<{ message: string; changes: AtomicFileChange[]; sha: string }>;
} {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const commits: Array<{ message: string; changes: AtomicFileChange[]; sha: string }> = [];
  let seq = 1;

  const client: GitHubVaultClient = {
    async listTree() {
      return Array.from(files.keys())
        .sort()
        .map((p) => ({
          path: p,
          sha: `blob-${p}`,
          type: "blob" as const,
        }));
    },
    async fetchFile(p: string) {
      return files.get(p) ?? null;
    },
    async commitAtomicChanges({ changes, commitMessage, branch }) {
      for (const change of changes) {
        if (change.content === null) {
          files.delete(change.path);
        } else {
          files.set(change.path, change.content);
        }
      }
      const sha = `commit-sha-${seq++}`;
      commits.push({ message: commitMessage, changes, sha });
      return {
        commitSha: sha,
        treeSha: `tree-sha-${seq}`,
        branch: branch ?? "main",
      };
    },
    async createBranch({ branchName }) {
      return `branch-${branchName}`;
    },
    async findOpenPullRequest() {
      return null;
    },
    async createPullRequest({ title, head }) {
      return {
        number: 1,
        url: `https://github.com/example/repo/pull/${title.length}`,
        branch: head,
      };
    },
  };

  return { client, files, commits };
}

test("getIsoWeekInfo calculates ISO-8601 week key and Monday..Sunday bounds accurately", () => {
  const w48 = getIsoWeekInfo(new Date("2026-11-27T13:00:00Z"));
  assert.equal(w48.weekKey, "2026-W48");
  assert.equal(w48.startDate, "2026-11-23");
  assert.equal(w48.endDate, "2026-11-29");

  const w01 = getIsoWeekInfo(new Date("2026-01-01T10:00:00Z"));
  assert.equal(w01.weekKey, "2026-W01");
  assert.equal(w01.startDate, "2025-12-29");
  assert.equal(w01.endDate, "2026-01-04");
});

test("runGardenerAgent repairs missing/dead wiki/index.md entries, applies safe edits, blocks protected paths, and skips when clean", async () => {
  const { client, files, commits } = createInMemoryGitHubVaultClient({
    "SCHEMA.md": "# SCHEMA\nPARA + Dziennik",
    "wiki/index.md": [
      "---",
      "title: Spis treści",
      "slug: index",
      "updated_at: 2026-11-26T10:00:00Z",
      "tags: [index]",
      "---",
      "",
      "# Spis treści Vaulta",
      "",
      "## Obszary",
      "- [[obszary/usunieta/strona|Martwy wpis]] — Do usunięcia",
      "",
      "## System",
      "- [[log|Dziennik zmian (log)]]",
      "",
    ].join("\n"),
    "wiki/log.md": "---\ntitle: Dziennik zmian\nslug: log\n---\n\n# Dziennik zmian\n",
    "wiki/obszary/finanse/cele.md": [
      "---",
      'title: "Finanse — cele"',
      "slug: obszary/finanse/cele",
      "updated_at: 2026-11-27T08:00:00Z",
      "tags: [finanse]",
      'summary: "Cele finansowe na 5 lat."',
      "---",
      "",
      "# Finanse — cele",
      "",
      "Oszczędzanie długoterminowe.",
    ].join("\n"),
    "wiki/projekty/foxie-notes/status.md": "# Chroniony status\n",
  });

  const firstRun = await runGardenerAgent({
    vaultClient: client,
    now: () => new Date("2026-11-27T12:00:00Z"),
    buildPlan: async () => ({
      summary: "Dodano powiązanie w finansach i zablokowano próbę edycji status.md",
      writes: [
        {
          path: "wiki/obszary/finanse/cele.md",
          title: "Finanse — cele",
          description: "Cele finansowe na 5 lat.",
          contentMarkdown: [
            "---",
            'title: "Finanse — cele"',
            "slug: obszary/finanse/cele",
            "updated_at: 2026-11-27T12:00:00Z",
            "tags: [finanse]",
            'summary: "Cele finansowe na 5 lat."',
            "---",
            "",
            "# Finanse — cele",
            "",
            "Powiązane: [[projekty/foxie-notes/index]]",
            "",
            "Oszczędzanie długoterminowe.",
          ].join("\n"),
        },
        {
          // Must be silently blocked by guardrails
          path: "wiki/projekty/foxie-notes/status.md",
          title: "Status",
          description: "Hacked",
          contentMarkdown: "# Nadpisany status",
        },
      ],
    }),
  });

  assert.equal(firstRun.status, "executed");
  assert.deepEqual(firstRun.indexRemoved, ["obszary/usunieta/strona"]);
  assert.equal(firstRun.indexAdded.includes("obszary/finanse/cele"), true);
  assert.deepEqual(firstRun.filesUpdated, ["wiki/obszary/finanse/cele.md"]);
  assert.equal(commits.length, 1);
  assert.equal(files.get("wiki/projekty/foxie-notes/status.md"), "# Chroniony status\n");
  assert.doesNotMatch(files.get("wiki/index.md") ?? "", /obszary\/usunieta\/strona/);
  assert.match(files.get("wiki/index.md") ?? "", /\[\[obszary\/finanse\/cele\|/);
  assert.match(files.get("wiki/log.md") ?? "", /Agent Ogrodnik/);

  // Second run with no new edits skips cleanly
  const secondRun = await runGardenerAgent({
    vaultClient: client,
    now: () => new Date("2026-11-27T12:05:00Z"),
    buildPlan: async () => ({ summary: "Wszystko czyste", writes: [] }),
  });
  assert.equal(secondRun.status, "skipped");
  assert.equal(secondRun.reason, "vault_already_clean");
  assert.equal(commits.length, 1);
});

test("runWeeklyReviewAgent creates weekly report, updates index & log, and skips duplicate unless forced", async () => {
  const { client, files, commits } = createInMemoryGitHubVaultClient({
    "wiki/index.md": [
      "---",
      "title: Spis treści",
      "slug: index",
      "---",
      "",
      "# Spis treści Vaulta",
      "",
      "## Dziennik",
      "- [[dziennik/2026-11-27|Dziennik 2026-11-27]] — Zapiski.",
      "",
      "## System",
      "- [[log|Dziennik zmian (log)]]",
      "",
    ].join("\n"),
    "wiki/log.md": "---\ntitle: Dziennik zmian\nslug: log\n---\n\n# Dziennik zmian\n\n## 2026-11-27\n- Dodano test.\n",
    "wiki/dziennik/2026-11-27.md": [
      "---",
      'title: "Dziennik 2026-11-27"',
      "slug: dziennik/2026-11-27",
      "---",
      "",
      "# Dziennik 2026-11-27",
      "",
      "## Zadania",
      "- [ ] Zadzwonić do rodziców @due(2026-11-28)",
    ].join("\n"),
    "wiki/pomysly/agent-ai-dla-developera.md": [
      "---",
      'title: "Agent AI dla developera"',
      "slug: pomysly/agent-ai-dla-developera",
      'summary: "Podział na zadania autonomiczne i wymagające approvala."',
      "---",
      "",
      "# Agent AI dla developera",
    ].join("\n"),
  });

  let capturedOpenTasks = 0;
  let capturedIdeas = 0;

  const res1 = await runWeeklyReviewAgent({
    vaultClient: client,
    now: () => new Date("2026-11-27T18:00:00Z"),
    generateReview: async (input) => {
      capturedOpenTasks = input.openTasks.length;
      capturedIdeas = input.ideas.length;
      return {
        summary: "Intensywny tydzień: wdrożenie agentów i przygotowanie wyjazdu.",
        bodyMarkdown: [
          "## Podsumowanie tygodnia",
          "Tydzień upłynął pod znakiem agentów Foxie Notes.",
          "",
          "## Najważniejsze tematy i postępy",
          "- [[dziennik/2026-11-27]]",
          "",
          "## Priorytety i otwarte zadania na kolejny tydzień",
          "- [ ] Zadzwonić do rodziców @due(2026-11-28)",
          "",
          "## Pomysły i decyzje",
          "- [[pomysly/agent-ai-dla-developera]]",
        ].join("\n"),
      };
    },
  });

  assert.equal(res1.status, "created");
  assert.equal(res1.weekKey, "2026-W48");
  assert.equal(res1.reportPath, "wiki/dziennik/tydzien-2026-W48.md");
  assert.equal(res1.journalDaysIncluded, 1);
  assert.equal(capturedOpenTasks, 1);
  assert.equal(capturedIdeas, 1);
  assert.equal(commits.length, 1);
  assert.equal(files.has("wiki/dziennik/tydzien-2026-W48.md"), true);
  assert.match(files.get("wiki/index.md") ?? "", /\[\[dziennik\/tydzien-2026-W48\|/);
  assert.match(files.get("wiki/log.md") ?? "", /Agent Przegląd Tygodniowy/);

  const resSkip = await runWeeklyReviewAgent({
    vaultClient: client,
    now: () => new Date("2026-11-27T19:00:00Z"),
    generateReview: async () => {
      throw new Error("Should not be called when review already exists");
    },
  });
  assert.equal(resSkip.status, "skipped");
  assert.equal(resSkip.reason, "weekly_review_already_exists");

  const resForce = await runWeeklyReviewAgent({
    vaultClient: client,
    force: true,
    now: () => new Date("2026-11-27T19:30:00Z"),
    generateReview: async () => ({
      summary: "Odświeżony przegląd tygodnia.",
      bodyMarkdown: "## Podsumowanie tygodnia\nOdświeżono.",
    }),
  });
  assert.equal(resForce.status, "created");
  assert.equal(commits.length, 2);
});

test("POST /api/agents/gardener and POST /api/agents/weekly-review enforce auth and execute cleanly", async () => {
  process.env.DEVICE_API_KEY = "test-device-key";
  process.env.GITHUB_VAULT_PREFIX = "";

  const { client } = createInMemoryGitHubVaultClient({
    "SCHEMA.md": "# SCHEMA",
    "wiki/index.md": "---\ntitle: Spis treści\nslug: index\n---\n\n# Spis treści\n\n## System\n- [[log|Dziennik zmian]]\n",
    "wiki/log.md": "---\ntitle: Dziennik zmian\nslug: log\n---\n\n# Dziennik zmian\n",
    "wiki/zasoby/notatka.md": "---\ntitle: Notatka\nslug: zasoby/notatka\nsummary: Test\n---\n\n# Notatka\n",
  });

  const app = createApp({
    now: () => new Date("2026-11-27T14:00:00Z"),
    vaultStore: createInMemoryVaultStore(),
    fetchVaultFile: (p) => client.fetchFile(p),
    vaultClient: client,
    buildGardenerPlan: async () => ({ summary: "OK", writes: [] }),
    generateWeeklyReview: async () => ({
      summary: "Podsumowanie API",
      bodyMarkdown: "## Podsumowanie tygodnia\nOK",
    }),
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const unauth = await fetch(`${baseUrl}/api/agents/gardener`, { method: "POST" });
    assert.equal(unauth.status, 401);

    const gardenerRes = await fetch(`${baseUrl}/api/agents/gardener`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "test-device-key" },
      body: JSON.stringify({}),
    });
    assert.equal(gardenerRes.status, 200);
    const gardenerJson = (await gardenerRes.json()) as { ok: boolean; status: string; indexAdded: string[] };
    assert.equal(gardenerJson.ok, true);
    assert.equal(gardenerJson.status, "executed");
    assert.deepEqual(gardenerJson.indexAdded, ["zasoby/notatka"]);

    const reviewRes = await fetch(`${baseUrl}/api/agents/weekly-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "test-device-key" },
      body: JSON.stringify({}),
    });
    assert.equal(reviewRes.status, 201);
    const reviewJson = (await reviewRes.json()) as { ok: boolean; status: string; weekKey: string };
    assert.equal(reviewJson.ok, true);
    assert.equal(reviewJson.status, "created");
    assert.equal(reviewJson.weekKey, "2026-W48");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
