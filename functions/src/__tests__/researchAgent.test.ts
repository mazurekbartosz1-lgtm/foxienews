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
  PullRequestResult,
} from "../services/github.js";
import type { OrganizerDecision } from "../services/inboxOrganizer.js";
import {
  buildResearchPaths,
  renderResearchReportMarkdown,
  runResearchAgent,
  type GeneratedResearchReport,
} from "../services/researchAgent.js";

function signPayload(body: string, secret: string): string {
  const hex = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${hex}`;
}

function createResearchMockVaultClient(initialFiles: Record<string, string>): {
  client: GitHubVaultClient;
  branches: Map<string, Map<string, string>>;
  openPrs: Array<PullRequestResult & { title: string; body: string }>;
  existingBranchNames: Set<string>;
} {
  const branches = new Map<string, Map<string, string>>([
    ["main", new Map(Object.entries(initialFiles))],
  ]);
  const existingBranchNames = new Set<string>(["main"]);
  const openPrs: Array<PullRequestResult & { title: string; body: string }> = [];
  let seq = 1;

  const client: GitHubVaultClient = {
    async listTree(ref = "main") {
      const files = branches.get(ref) ?? branches.get("main")!;
      return Array.from(files.keys())
        .sort()
        .map((path) => ({ path, sha: `blob-${path}`, type: "blob" as const }));
    },
    async fetchFile(path: string, ref = "main") {
      const files = branches.get(ref) ?? branches.get("main")!;
      return files.get(path) ?? null;
    },
    async commitAtomicChanges({ changes, branch = "main" }) {
      const files = branches.get(branch) ?? new Map(branches.get("main")!);
      for (const change of changes as AtomicFileChange[]) {
        if (change.content === null) {
          files.delete(change.path);
        } else {
          files.set(change.path, change.content);
        }
      }
      branches.set(branch, files);
      return {
        commitSha: `sha-${seq++}`,
        treeSha: `tree-${seq}`,
        branch,
      };
    },
    async createBranch({ branchName, fromBranch = "main" }) {
      if (existingBranchNames.has(branchName)) {
        const err = new Error("Reference already exists") as Error & { status?: number };
        err.status = 422;
        throw err;
      }
      existingBranchNames.add(branchName);
      const baseFiles = branches.get(fromBranch) ?? branches.get("main")!;
      branches.set(branchName, new Map(baseFiles));
      return `sha-base-${seq++}`;
    },
    async findOpenPullRequest(headBranch: string) {
      const found = openPrs.find((pr) => pr.branch === headBranch);
      if (!found) return null;
      return { number: found.number, url: found.url, branch: found.branch };
    },
    async createPullRequest({ title, body, head }) {
      const pr = {
        number: openPrs.length + 1,
        url: `https://github.com/mazurekbartosz1-lgtm/obsydianandwiki/pull/${openPrs.length + 1}`,
        branch: head,
        title,
        body,
      };
      openPrs.push(pr);
      return { number: pr.number, url: pr.url, branch: pr.branch };
    },
  };

  return { client, branches, openPrs, existingBranchNames };
}

test("buildResearchPaths and renderResearchReportMarkdown format valid Obsidian report", () => {
  const paths = buildResearchPaths({
    topicTitle: "Bateria LiPo 3.7V do Waveshare",
    targetWikiPath: "wiki/pomysly/bateria-lipo-waveshare.md",
  });
  assert.equal(paths.topicSlug, "bateria-lipo-waveshare");
  assert.equal(paths.reportRelativePath, "wiki/pomysly/bateria-lipo-waveshare/research.md");
  assert.equal(paths.branchName, "agent/research-bateria-lipo-waveshare");

  const generated: GeneratedResearchReport = {
    title: "Bateria LiPo 3.7V do Waveshare",
    summary: "Najlepszym wyborem jest ogniwo 602535 600 mAh z PCM.",
    reportMarkdown:
      "# Nadmiarowy H1\n\n## Podsumowanie wykonawcze\n\nNajlepszym wyborem jest ogniwo 602535 600 mAh z PCM.",
    sources: [{ title: "Waveshare Wiki", uri: "https://www.waveshare.com/wiki/ESP32-S3" }],
    searchQueries: ["ESP32-S3 e-Paper 1.54 battery JST"],
    grounded: true,
  };

  const md = renderResearchReportMarkdown({
    topicTitle: "Bateria LiPo 3.7V do Waveshare",
    topicSlug: paths.topicSlug,
    updatedAtIso: "2026-11-26T18:20:00Z",
    extraTags: ["sprzet", "#pomysl"],
    generated,
    sourcePath: "raw/processed/2026-11/2026-11-26-lipo.md",
    targetWikiPath: "wiki/pomysly/bateria-lipo-waveshare.md",
    branchName: paths.branchName,
  });

  assert.match(md, /^title: "Research: Bateria LiPo 3\.7V do Waveshare"/m);
  assert.match(md, /^slug: pomysly\/bateria-lipo-waveshare\/research/m);
  assert.match(md, /^grounded: true/m);
  assert.match(md, /Powiązane: \[\[pomysly\/bateria-lipo-waveshare\]\]/);
  assert.doesNotMatch(md, /Nadmiarowy H1/);
  assert.match(md, /\[Waveshare Wiki\]\(https:\/\/www\.waveshare\.com\/wiki\/ESP32-S3\)/);
});

test("runResearchAgent skips duplicate open PR and falls back with timestamp suffix on 422 branch collision", async () => {
  const { client, openPrs, existingBranchNames } = createResearchMockVaultClient({});
  existingBranchNames.add("agent/research-czujnik-co2");

  const mockGen = async (): Promise<GeneratedResearchReport> => ({
    title: "Czujnik CO2",
    summary: "Sensirion SCD41 zapewnia niskie zużycie prądu.",
    reportMarkdown: "## Podsumowanie wykonawcze\n\nSensirion SCD41 jest najlepszy do baterii.",
    sources: [{ title: "Sensirion", uri: "https://sensirion.com" }],
    searchQueries: ["SCD41 power consumption"],
    grounded: true,
  });

  const first = await runResearchAgent({
    topicTitle: "Czujnik CO2",
    noteMarkdown: "Zbadać czujniki CO2 pod e-ink.",
    vaultClient: client,
    generateReport: mockGen,
    now: () => new Date("2026-11-26T18:25:00Z"),
  });

  assert.equal(first.status, "created");
  assert.equal(first.branch, "agent/research-czujnik-co2-20261126-1825");
  assert.equal(openPrs.length, 1);

  // When an open PR exists on the canonical branch, skip without calling generator again
  openPrs.push({
    number: 99,
    url: "https://github.com/example/pull/99",
    branch: "agent/research-nowy-temat",
    title: "Existing",
    body: "",
  });
  let called = false;
  const skipped = await runResearchAgent({
    topicTitle: "Nowy temat",
    noteMarkdown: "Treść",
    vaultClient: client,
    generateReport: async () => {
      called = true;
      return mockGen();
    },
  });
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.prNumber, 99);
  assert.equal(called, false);
});

test("Webhook research-idea -> Organizer -> Researcher PR & POST /api/agents/research work end-to-end", async () => {
  process.env.DEVICE_API_KEY = "test-device-key";
  process.env.GITHUB_WEBHOOK_SECRET = "hook-secret";
  process.env.GITHUB_BRANCH = "main";
  process.env.GITHUB_VAULT_PREFIX = "";

  const ideaInboxPath = "raw/inbox/2026-11-26T18-10-00Z-web-dobor-baterii-lipo.md";
  const { client, branches, openPrs } = createResearchMockVaultClient({
    "SCHEMA.md": "# SCHEMA",
    "wiki/index.md": "---\ntitle: Spis treści\nslug: index\n---\n\n# Spis treści\n\n## System\n- [[log|Log]]\n",
    "wiki/log.md": "---\ntitle: Log\nslug: log\n---\n\n# Log\n",
    [ideaInboxPath]: [
      "---",
      "created_at: 2026-11-26T18:10:00Z",
      "source: web",
      "type: text-note",
      "tags: [inbox, pomysl, sprzet]",
      "---",
      "",
      "# Dobór baterii LiPo do Waveshare V2",
      "",
      "Sprawdzić jakie ogniwo LiPo 3.7V z JST 1.25mm zmieści się w obudowie.",
    ].join("\n"),
  });

  const store = createInMemoryVaultStore();

  const mockClassify = async (): Promise<OrganizerDecision> => ({
    intent: "research-idea",
    targetPath: "wiki/pomysly/dobor-baterii-lipo.md",
    title: "Dobór baterii LiPo do Waveshare V2",
    summary: "Pomysł na dobór ogniwa LiPo i obudowy 3D do Waveshare 1.54 V2.",
    tags: ["pomysl", "sprzet"],
    relatedLinks: ["projekty/foxie-notes/sprzet-waveshare-v2"],
    sectionHeading: "Założenia wstępne",
    contentMarkdown: "Sprawdzić wymiary i złącze JST dla ogniwa LiPo 3.7V.",
    tasks: [],
    indexSection: "Pomysły",
    indexDescription: "Analiza doboru baterii LiPo do Waveshare V2.",
    logEntry: "Dodano pomysł doboru baterii LiPo do wiki/pomysly/dobor-baterii-lipo.md",
  });

  const mockResearch = async (input: { topicTitle: string }): Promise<GeneratedResearchReport> => ({
    title: input.topicTitle,
    summary: "Ogniwo 602535 600 mAh z wtykiem JST GH 1.25mm pasuje do obudowy.",
    reportMarkdown: [
      "## Podsumowanie wykonawcze",
      "",
      "Ogniwo 602535 600 mAh z PCM i polaryzacją zgodną z Waveshare zapewni ok. 2-3 tygodnie pracy.",
      "",
      "## Następne kroki",
      "- [ ] Zmierzyć wnękę w obudowie przed zamówieniem ogniwa @due(2026-12-01)",
    ].join("\n"),
    sources: [{ title: "Waveshare 1.54 V2", uri: "https://www.waveshare.com/wiki/ESP32-S3-Touch-ePaper-1.54" }],
    searchQueries: ["Waveshare ESP32-S3-Touch-ePaper-1.54 battery connector"],
    grounded: true,
  });

  const app = createApp({
    now: () => new Date("2026-11-26T18:30:00Z"),
    vaultStore: store,
    fetchVaultFile: (p) => client.fetchFile(p),
    vaultClient: client,
    classifyInboxNote: mockClassify,
    generateResearchReport: mockResearch,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Webhook classifies note as research-idea and triggers Research PR automatically
    const pushBody = JSON.stringify({
      ref: "refs/heads/main",
      after: "user-commit-idea",
      commits: [{ message: "capture(web): Dobór baterii LiPo", added: [ideaInboxPath] }],
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
        research?: { status: string; prNumber?: number; branch?: string; reportPath?: string };
      }>;
    };

    assert.equal(hookJson.organized?.[0].status, "processed");
    assert.equal(hookJson.organized?.[0].intent, "research-idea");
    assert.equal(hookJson.organized?.[0].research?.status, "created");
    assert.equal(hookJson.organized?.[0].research?.branch, "agent/research-dobor-baterii-lipo");
    assert.equal(
      hookJson.organized?.[0].research?.reportPath,
      "wiki/pomysly/dobor-baterii-lipo/research.md",
    );
    assert.equal(openPrs.length, 1);

    // Main branch should NOT contain research.md yet (it lives only on the PR branch)
    const mainFiles = branches.get("main")!;
    assert.equal(mainFiles.has("wiki/pomysly/dobor-baterii-lipo.md"), true);
    assert.equal(mainFiles.has("wiki/pomysly/dobor-baterii-lipo/research.md"), false);

    const prBranchFiles = branches.get("agent/research-dobor-baterii-lipo")!;
    const reportMd = prBranchFiles.get("wiki/pomysly/dobor-baterii-lipo/research.md") ?? "";
    assert.match(reportMd, /Waveshare 1\.54 V2/);
    assert.match(reportMd, /- \[ \] Zmierzyć wnękę w obudowie/);

    const jobs = store.getAllInboxJobs();
    assert.equal(jobs[0].researchPrNumber, 1);
    assert.match(jobs[0].researchPrUrl ?? "", /pull\/1$/);

    // 2. POST /api/agents/research endpoint auth + validation + execution
    const unauth = await fetch(`${baseUrl}/api/agents/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Temat" }),
    });
    assert.equal(unauth.status, 401);

    const bad = await fetch(`${baseUrl}/api/agents/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "test-device-key" },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);

    const manualRes = await fetch(`${baseUrl}/api/agents/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "test-device-key" },
      body: JSON.stringify({
        title: "Alternatywne zasilanie solarne",
        text: "Zbadać panel solarny 5V do stacji pogodowej e-ink.",
        tags: ["energia"],
      }),
    });
    assert.equal(manualRes.status, 201);
    const manualJson = (await manualRes.json()) as {
      ok: boolean;
      status: string;
      prNumber: number;
      branch: string;
    };
    assert.equal(manualJson.ok, true);
    assert.equal(manualJson.status, "created");
    assert.equal(manualJson.prNumber, 2);
    assert.equal(manualJson.branch, "agent/research-alternatywne-zasilanie-solarne");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
