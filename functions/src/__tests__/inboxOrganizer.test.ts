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
import {
  buildProcessedPath,
  mergeIntoExistingWikiPage,
  prependWikiLogMarkdown,
  sanitizeTargetPath,
  updateWikiIndexMarkdown,
  type OrganizerDecision,
} from "../services/inboxOrganizer.js";
import { extractNewInboxFilesFromPush } from "../services/wikiSync.js";

function signPayload(body: string, secret: string): string {
  const hex = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${hex}`;
}

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
        .map((path) => ({
          path,
          sha: `blob-${path}`,
          type: "blob" as const,
        }));
    },
    async fetchFile(path: string) {
      return files.get(path) ?? null;
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

test("sanitizeTargetPath enforces PARA + Dziennik, blocks traversal and protected files, and routes test notes to journal", () => {
  assert.equal(
    sanitizeTargetPath({
      rawTargetPath: "wiki/obszary/auto/Toyota Serwis.md",
      noteDate: "2026-11-26",
    }),
    "wiki/obszary/auto/toyota-serwis.md",
  );

  assert.equal(
    sanitizeTargetPath({
      rawTargetPath: "wiki/../../etc/passwd",
      noteDate: "2026-11-26",
    }),
    "wiki/dziennik/2026-11-26.md",
  );

  assert.equal(
    sanitizeTargetPath({
      rawTargetPath: "wiki/index.md",
      noteDate: "2026-11-26",
    }),
    "wiki/dziennik/2026-11-26.md",
  );

  assert.equal(
    sanitizeTargetPath({
      rawTargetPath: "wiki/projekty/foxie-notes/status.md",
      noteDate: "2026-11-26",
    }),
    "wiki/projekty/foxie-notes/notatki.md",
  );

  assert.equal(
    sanitizeTargetPath({
      rawTargetPath: "wiki/obszary/dom/test.md",
      noteDate: "2026-11-26",
      isTestNote: true,
    }),
    "wiki/dziennik/2026-11-26.md",
  );
});

test("buildProcessedPath, mergeIntoExistingWikiPage, updateWikiIndexMarkdown, and prependWikiLogMarkdown work deterministically", () => {
  assert.equal(
    buildProcessedPath("raw/inbox/2026-11-26T14-26-19Z-waveshare-154-toyota.md", "2026-11"),
    "raw/processed/2026-11/2026-11-26T14-26-19Z-waveshare-154-toyota.md",
  );

  const existingPage = [
    "---",
    'title: "Dziennik 2026-11-26"',
    "slug: dziennik/2026-11-26",
    "updated_at: 2026-11-26T14:00:00Z",
    "tags: [dziennik]",
    'summary: "Wpisy z dnia 2026-11-26"',
    "---",
    "",
    "# Dziennik 2026-11-26",
    "",
    "Wpisy z dnia 2026-11-26",
    "",
    "## 14:26 — Zachód słońca",
    "",
    "Pastelowe kolory nieba.",
    "",
    "## Zadania",
    "- [ ] Kupić mleko",
    "",
    "## Źródła",
    "- `raw/processed/2026-11/2026-11-26T14-26-31Z-waveshare-154-zachod.md`",
    "",
  ].join("\n");

  const merged = mergeIntoExistingWikiPage({
    existingMarkdown: existingPage,
    targetPath: "wiki/dziennik/2026-11-26.md",
    tags: ["test", "dziennik"],
    sectionHeading: "Test dyktafonu",
    contentMarkdown: "Krótki test po powrocie do domu.",
    tasks: ["Kupić mleko", "Sprawdzić baterię @due(2026-11-28)"],
    processedPath: "raw/processed/2026-11/2026-11-26T14-28-30Z-waveshare-154-test.md",
    noteTime: "14:28",
    updatedAtIso: "2026-11-26T16:40:00Z",
    fallbackTitle: "Dziennik 2026-11-26",
    fallbackSummary: "Wpisy z dnia",
    isTestNote: true,
  });

  assert.match(merged, /tags: \[dziennik, test\]/);
  assert.match(merged, /## 14:26 — Zachód słońca/);
  assert.match(merged, /## 14:28 — Test dyktafonu `#test`/);
  assert.equal((merged.match(/Kupić mleko/g) ?? []).length, 1);
  assert.match(merged, /- \[ \] Sprawdzić baterię @due\(2026-11-28\)/);
  assert.match(merged, /2026-11-26T14-28-30Z-waveshare-154-test\.md/);

  const idx1 = updateWikiIndexMarkdown({
    existingIndexMarkdown: null,
    slug: "obszary/auto/toyota",
    title: "Serwis Toyoty",
    description: "Sprawy serwisowe auta Toyota.",
    section: "Obszary",
    updatedAtIso: "2026-11-26T16:40:00Z",
  });
  assert.equal(idx1.changed, true);
  assert.match(idx1.markdown, /## Obszary\n- \[\[obszary\/auto\/toyota\|Serwis Toyoty\]\]/);

  const idx2 = updateWikiIndexMarkdown({
    existingIndexMarkdown: idx1.markdown,
    slug: "obszary/auto/toyota",
    title: "Serwis Toyoty",
    description: "Duplikat.",
    section: "Obszary",
    updatedAtIso: "2026-11-26T16:41:00Z",
  });
  assert.equal(idx2.changed, false);

  const logMd = prependWikiLogMarkdown({
    existingLogMarkdown: null,
    dateStr: "2026-11-26",
    updatedAtIso: "2026-11-26T16:40:00Z",
    intent: "todo",
    logEntry: "Dodano przypomnienie o telefonie do Toyoty",
    slug: "obszary/auto/toyota",
    title: "Serwis Toyoty",
    processedPath: "raw/processed/2026-11/2026-11-26T14-26-19Z-waveshare-154-toyota.md",
  });
  assert.match(logMd, /## 2026-11-26\n- \*\*Agent Organizator \(`todo`\):\*\*/);
});

test("extractNewInboxFilesFromPush skips agent/sync commits to prevent webhook loops", () => {
  const newFiles = extractNewInboxFilesFromPush({
    ref: "refs/heads/main",
    commits: [
      {
        message: "capture(waveshare-154): Telefon do Toyoty",
        added: ["raw/inbox/2026-11-26T14-26-19Z-waveshare-154-toyota.md"],
      },
      {
        message: "agent(organizer): Serwis Toyoty (todo)",
        added: [
          "wiki/obszary/auto/toyota.md",
          "raw/processed/2026-11/2026-11-26T14-26-19Z-waveshare-154-toyota.md",
          "raw/inbox/should-be-ignored.md",
        ],
        removed: ["raw/inbox/2026-11-26T14-26-19Z-waveshare-154-toyota.md"],
      },
      {
        message: "docs(vault): sync Foxie Notes",
        added: ["raw/inbox/also-ignored.md"],
      },
    ],
  });

  // Removed in the later agent commit was ignored by anti-loop, keeping original capture path if only added in user commit,
  // and ignoring agent-added files. Wait: our function skips agent commits entirely so removed in agent commit doesn't erase user commit in same push,
  // while idempotency (`inbox_jobs` + fetchFile === null) safely handles already-moved files.
  assert.deepEqual(newFiles, ["raw/inbox/2026-11-26T14-26-19Z-waveshare-154-toyota.md"]);
});

test("Webhook & POST /api/agents/organize-inbox run Organizer end-to-end with anti-loop and idempotency", async () => {
  process.env.DEVICE_API_KEY = "test-device-key";
  process.env.GITHUB_WEBHOOK_SECRET = "hook-secret";
  process.env.GITHUB_BRANCH = "main";
  process.env.GITHUB_VAULT_PREFIX = "";

  const toyotaInboxPath =
    "raw/inbox/2026-11-26T14-26-19Z-waveshare-154-telefon-do-toyoty.md";
  const sunsetInboxPath =
    "raw/inbox/2026-11-26T14-26-31Z-waveshare-154-zachod-slonca.md";

  const { client, files, commits } = createInMemoryGitHubVaultClient({
    "SCHEMA.md": "# SCHEMA\nPARA + Dziennik",
    "wiki/index.md": "---\ntitle: Spis treści\nslug: index\n---\n\n# Spis treści\n\n## System\n- [[log|Dziennik zmian]]\n",
    "wiki/log.md": "---\ntitle: Dziennik zmian\nslug: log\n---\n\n# Dziennik zmian\n",
    [toyotaInboxPath]: [
      "---",
      "created_at: 2026-11-26T14:26:19Z",
      "source: waveshare-154",
      "type: voice-note",
      "tags: [inbox, auto, toyota]",
      "---",
      "",
      "# Telefon do Toyoty w sprawie zderzaka",
      "",
      "Skontaktować się z serwisem Toyoty w sprawie oględzin zderzaka.",
      "",
      "## Zadania",
      "- [ ] Zadzwonić do Toyoty i umówić oględziny zderzaka",
    ].join("\n"),
    [sunsetInboxPath]: [
      "---",
      "created_at: 2026-11-26T14:26:31Z",
      "source: waveshare-154",
      "type: voice-note",
      "tags: [inbox, obserwacja]",
      "---",
      "",
      "# Zachód słońca",
      "",
      "Piękne pastelowe kolory nieba.",
    ].join("\n"),
  });

  const store = createInMemoryVaultStore();
  let classifyCalls = 0;

  const mockClassify = async (input: {
    inboxRelativePath: string;
    noteDate: string;
  }): Promise<OrganizerDecision> => {
    classifyCalls++;
    if (input.inboxRelativePath.includes("toyot")) {
      return {
        intent: "todo",
        targetPath: "wiki/obszary/auto/toyota.md",
        title: "Toyota — serwis i naprawy",
        summary: "Sprawy serwisowe samochodu Toyota, w tym oględziny zderzaka.",
        tags: ["auto", "toyota", "serwis"],
        relatedLinks: [],
        sectionHeading: "Oględziny zderzaka",
        contentMarkdown: "Skontaktować się z serwisem Toyoty w celu umówienia oględzin zderzaka.",
        tasks: ["Zadzwonić do Toyoty i umówić oględziny zderzaka #auto"],
        indexSection: "Obszary",
        indexDescription: "Sprawy serwisowe auta Toyota.",
        logEntry: "Dodano zadanie kontaktu z serwisem Toyoty",
      };
    }

    return {
      intent: "journal",
      targetPath: `wiki/dziennik/${input.noteDate}.md`,
      title: `Dziennik ${input.noteDate}`,
      summary: "Obserwacje z dnia 2026-11-26.",
      tags: ["dziennik", "natura"],
      relatedLinks: [],
      sectionHeading: "Zachód słońca",
      contentMarkdown: "Pastelowe kolory nieba podczas spaceru.",
      tasks: [],
      indexSection: "Dziennik",
      indexDescription: "Zapiski dzienne z 2026-11-26.",
      logEntry: "Dopisano obserwację zachodu słońca do dziennika",
    };
  };

  const app = createApp({
    now: () => new Date("2026-11-26T17:00:00Z"),
    vaultStore: store,
    fetchVaultFile: (p) => client.fetchFile(p),
    vaultClient: client,
    classifyInboxNote: mockClassify,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Webhook triggered by capture push organizes toyotaInboxPath
    const pushBody = JSON.stringify({
      ref: "refs/heads/main",
      after: "user-commit-1",
      commits: [
        {
          message: "capture(waveshare-154): Telefon do Toyoty",
          added: [toyotaInboxPath],
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
    const hookJson = (await hookRes.json()) as {
      organized?: Array<{ status: string; targetPath?: string; processedPath?: string }>;
    };
    assert.equal(hookJson.organized?.length, 1);
    assert.equal(hookJson.organized?.[0].status, "processed");
    assert.equal(hookJson.organized?.[0].targetPath, "wiki/obszary/auto/toyota.md");
    assert.equal(
      hookJson.organized?.[0].processedPath,
      "raw/processed/2026-11/2026-11-26T14-26-19Z-waveshare-154-telefon-do-toyoty.md",
    );

    assert.equal(files.has(toyotaInboxPath), false);
    assert.equal(
      files.has("raw/processed/2026-11/2026-11-26T14-26-19Z-waveshare-154-telefon-do-toyoty.md"),
      true,
    );
    assert.match(
      files.get("wiki/obszary/auto/toyota.md") ?? "",
      /- \[ \] Zadzwonić do Toyoty i umówić oględziny zderzaka #auto/,
    );
    assert.match(files.get("wiki/index.md") ?? "", /\[\[obszary\/auto\/toyota\|/);
    assert.match(files.get("wiki/log.md") ?? "", /Agent Organizator/);
    assert.equal(commits.length, 1);

    // 2. Agent commit push triggers webhook only for wikiSync, NOT organizer (anti-loop)
    const agentPushBody = JSON.stringify({
      ref: "refs/heads/main",
      after: commits[0].sha,
      commits: [
        {
          message: commits[0].message,
          added: [
            "wiki/obszary/auto/toyota.md",
            "raw/processed/2026-11/2026-11-26T14-26-19Z-waveshare-154-telefon-do-toyoty.md",
          ],
          modified: ["wiki/index.md", "wiki/log.md"],
          removed: [toyotaInboxPath],
        },
      ],
    });
    const agentHookRes = await fetch(`${baseUrl}/api/webhook/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": signPayload(agentPushBody, "hook-secret"),
      },
      body: agentPushBody,
    });
    assert.equal(agentHookRes.status, 200);
    const agentHookJson = (await agentHookRes.json()) as {
      syncedPages: number;
      organized?: unknown[];
    };
    assert.equal(agentHookJson.syncedPages, 3);
    assert.equal(agentHookJson.organized, undefined);
    assert.equal(classifyCalls, 1);

    // 3. Re-delivering the first webhook is idempotent (skipped via inbox_jobs)
    const dupHookRes = await fetch(`${baseUrl}/api/webhook/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": signPayload(pushBody, "hook-secret"),
      },
      body: pushBody,
    });
    assert.equal(dupHookRes.status, 200);
    const dupJson = (await dupHookRes.json()) as {
      organized?: Array<{ status: string }>;
    };
    assert.equal(dupJson.organized?.[0].status, "skipped");
    assert.equal(classifyCalls, 1);

    // 4. POST /api/agents/organize-inbox requires auth and processes remaining inbox note
    const unauthRes = await fetch(`${baseUrl}/api/agents/organize-inbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthRes.status, 401);

    const batchRes = await fetch(`${baseUrl}/api/agents/organize-inbox`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "test-device-key",
      },
      body: JSON.stringify({ limit: 5 }),
    });
    assert.equal(batchRes.status, 200);
    const batchJson = (await batchRes.json()) as {
      ok: boolean;
      processed: number;
      skipped: number;
      errors: number;
    };
    assert.equal(batchJson.ok, true);
    assert.equal(batchJson.processed, 1);
    assert.equal(batchJson.skipped, 0);
    assert.equal(batchJson.errors, 0);
    assert.equal(files.has(sunsetInboxPath), false);
    assert.equal(files.has("wiki/dziennik/2026-11-26.md"), true);
    assert.equal(store.getAllInboxJobs().filter((j) => j.status === "done").length, 2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
