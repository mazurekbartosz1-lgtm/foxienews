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

test("buildResearchPaths maps PARA categories and renderResearchReportMarkdown formats valid report", () => {
  const paths = buildResearchPaths({
    topicTitle: "Bateria LiPo 3.7V do Waveshare",
    targetWikiPath: "wiki/pomysly/bateria-lipo-waveshare.md",
  });
  assert.equal(paths.topicSlug, "bateria-lipo-waveshare");
  assert.equal(paths.reportRelativePath, "wiki/pomysly/bateria-lipo-waveshare/research.md");
  assert.equal(paths.reportSlug, "pomysly/bateria-lipo-waveshare/research");
  assert.equal(paths.indexSection, "Pomysły");
  assert.equal(paths.branchName, "main");

  const obsPaths = buildResearchPaths({
    topicTitle: "Samopoczucie po biegu",
    targetWikiPath: "wiki/obszary/zdrowie/samopoczucie.md",
  });
  assert.equal(obsPaths.reportRelativePath, "wiki/obszary/zdrowie/samopoczucie/research.md");
  assert.equal(obsPaths.indexSection, "Obszary");
  assert.equal(obsPaths.categoryTag, "obszar");

  const projPaths = buildResearchPaths({
    topicTitle: "Remont łazienki",
    targetWikiPath: "wiki/projekty/dom/remont.md",
  });
  assert.equal(projPaths.reportRelativePath, "wiki/projekty/dom/remont/research.md");
  assert.equal(projPaths.indexSection, "Projekty");

  const resPaths = buildResearchPaths({
    topicTitle: "Kawa przelewowa",
    targetWikiPath: "wiki/zasoby/kawa.md",
  });
  assert.equal(resPaths.reportRelativePath, "wiki/zasoby/kawa/research.md");
  assert.equal(resPaths.indexSection, "Zasoby");

  const noDoubleNest = buildResearchPaths({
    topicTitle: "Samopoczucie",
    targetWikiPath: "wiki/obszary/zdrowie/samopoczucie/research.md",
  });
  assert.equal(noDoubleNest.reportRelativePath, "wiki/obszary/zdrowie/samopoczucie/research.md");

  const protectedFallback = buildResearchPaths({
    topicTitle: "Status Foxie",
    targetWikiPath: "wiki/projekty/foxie-notes/status.md",
  });
  assert.equal(protectedFallback.reportRelativePath, "wiki/pomysly/status-foxie/research.md");
  assert.equal(protectedFallback.indexSection, "Pomysły");

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
    reportSlug: paths.reportSlug,
    categoryTag: paths.categoryTag,
    updatedAtIso: "2026-11-26T18:20:00Z",
    extraTags: ["sprzet", "#pomysl"],
    generated,
    sourcePath: "raw/processed/2026-11/2026-11-26-lipo.md",
    targetWikiPath: "wiki/pomysly/bateria-lipo-waveshare.md",
    branchName: "main",
  });

  assert.match(md, /^title: "Research: Bateria LiPo 3\.7V do Waveshare"/m);
  assert.match(md, /^slug: pomysly\/bateria-lipo-waveshare\/research/m);
  assert.match(md, /^grounded: true/m);
  assert.match(md, /Powiązane: \[\[pomysly\/bateria-lipo-waveshare\]\]/);
  assert.match(md, /Publikacja: bezpośrednio w vault \(`main`\)/);
  assert.doesNotMatch(md, /Nadmiarowy H1/);
  assert.match(md, /\[Waveshare Wiki\]\(https:\/\/www\.waveshare\.com\/wiki\/ESP32-S3\)/);
});

test("runResearchAgent publishes directly to main in matching PARA category, updates index + log + parent, and skips duplicates unless forced", async () => {
  const { client, branches, openPrs } = createResearchMockVaultClient({
    "wiki/index.md": "---\ntitle: Spis treści\nslug: index\n---\n\n# Spis treści\n\n## Obszary\n- [[obszary/zdrowie/samopoczucie|Zdrowie i samopoczucie]] — Monitorowanie samopoczucia.\n",
    "wiki/log.md": "---\ntitle: Log zmian\nslug: log\n---\n\n# Log zmian\n",
    "wiki/obszary/zdrowie/samopoczucie.md": "---\ntitle: Zdrowie i samopoczucie\n---\n\n# Zdrowie i samopoczucie\n\nSpadek energii po biegu 8 km.\n",
  });

  let callCount = 0;
  const mockGen = async (): Promise<GeneratedResearchReport> => {
    callCount++;
    return {
      title: "Regeneracja po biegu",
      summary: "Odpoczynek 48h, nawodnienie i sen poprawiają regenerację.",
      reportMarkdown: "## Podsumowanie wykonawcze\n\nOdpoczynek 48h, nawodnienie i sen.",
      sources: [{ title: "Sports Med", uri: "https://example.test/recovery" }],
      searchQueries: ["running fatigue recovery"],
      grounded: true,
    };
  };

  const first = await runResearchAgent({
    topicTitle: "Regeneracja po biegu",
    noteMarkdown: "Spadek energii po biegu.",
    targetWikiPath: "wiki/obszary/zdrowie/samopoczucie.md",
    vaultClient: client,
    generateReport: mockGen,
    now: () => new Date("2026-11-27T10:30:00Z"),
  });

  assert.equal(first.status, "created");
  assert.equal(first.branch, "main");
  assert.equal(first.reportPath, "wiki/obszary/zdrowie/samopoczucie/research.md");
  assert.equal(openPrs.length, 0);
  assert.equal(callCount, 1);

  const mainFiles = branches.get("main")!;
  assert.equal(mainFiles.has("wiki/obszary/zdrowie/samopoczucie/research.md"), true);
  assert.match(
    mainFiles.get("wiki/index.md") ?? "",
    /\[\[obszary\/zdrowie\/samopoczucie\/research\|Research: Regeneracja po biegu\]\]/,
  );
  assert.match(
    mainFiles.get("wiki/log.md") ?? "",
    /\*\*Agent Researcher \(`research`\):\*\* Opublikowano raport \[\[obszary\/zdrowie\/samopoczucie\/research\|Research: Regeneracja po biegu\]\]/,
  );
  assert.match(
    mainFiles.get("wiki/obszary/zdrowie/samopoczucie.md") ?? "",
    /## Powiązany research[\s\S]*\[\[obszary\/zdrowie\/samopoczucie\/research\|Research: Regeneracja po biegu\]\]/,
  );

  const skipped = await runResearchAgent({
    topicTitle: "Regeneracja po biegu",
    noteMarkdown: "Spadek energii po biegu.",
    targetWikiPath: "wiki/obszary/zdrowie/samopoczucie.md",
    vaultClient: client,
    generateReport: mockGen,
  });
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.reason, "research_already_exists");
  assert.equal(callCount, 1);

  const forced = await runResearchAgent({
    topicTitle: "Regeneracja po biegu",
    noteMarkdown: "Spadek energii po biegu.",
    targetWikiPath: "wiki/obszary/zdrowie/samopoczucie.md",
    vaultClient: client,
    generateReport: mockGen,
    force: true,
  });
  assert.equal(forced.status, "created");
  assert.equal(callCount, 2);
});

test("Webhook research-idea -> Organizer -> Researcher publishes directly to main & POST /api/agents/research works end-to-end", async () => {
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
    assert.equal(hookJson.organized?.[0].research?.branch, "main");
    assert.equal(
      hookJson.organized?.[0].research?.reportPath,
      "wiki/pomysly/dobor-baterii-lipo/research.md",
    );
    assert.equal(openPrs.length, 0);

    // Main branch directly contains both the idea page and research.md + updated index/log
    const mainFiles = branches.get("main")!;
    assert.equal(mainFiles.has("wiki/pomysly/dobor-baterii-lipo.md"), true);
    assert.equal(mainFiles.has("wiki/pomysly/dobor-baterii-lipo/research.md"), true);

    const reportMd = mainFiles.get("wiki/pomysly/dobor-baterii-lipo/research.md") ?? "";
    assert.match(reportMd, /Waveshare 1\.54 V2/);
    assert.match(reportMd, /- \[ \] Zmierzyć wnękę w obudowie/);
    assert.match(
      mainFiles.get("wiki/index.md") ?? "",
      /\[\[pomysly\/dobor-baterii-lipo\/research\|Research: Dobór baterii LiPo do Waveshare V2\]\]/,
    );
    assert.match(
      mainFiles.get("wiki/pomysly/dobor-baterii-lipo.md") ?? "",
      /\[\[pomysly\/dobor-baterii-lipo\/research\|/,
    );

    const jobs = store.getAllInboxJobs();
    assert.equal(jobs[0].researchPrNumber, undefined);
    assert.equal(jobs[0].researchReportPath, "wiki/pomysly/dobor-baterii-lipo/research.md");

    // 2. POST /api/agents/research endpoint auth + validation + direct execution
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
      reportPath: string;
      branch: string;
    };
    assert.equal(manualJson.ok, true);
    assert.equal(manualJson.status, "created");
    assert.equal(manualJson.branch, "main");
    assert.equal(
      manualJson.reportPath,
      "wiki/pomysly/alternatywne-zasilanie-solarne/research.md",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
