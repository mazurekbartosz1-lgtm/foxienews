import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../app.js";
import {
  buildCaptureMarkdown,
  buildInboxPath,
  slugifyPolish,
} from "../services/markdown.js";

test("slugifyPolish transliterates Polish characters cleanly", () => {
  assert.equal(
    slugifyPolish("Żółć gęślą jaźń — Pomysł #1!"),
    "zolc-gesla-jazn-pomysl-1",
  );
  assert.equal(slugifyPolish("   "), "notatka");
});

test("buildInboxPath builds schema-compliant inbox path with optional prefix", () => {
  const fixedDate = new Date("2026-11-25T19:10:05.123Z");

  assert.equal(
    buildInboxPath({
      createdAt: fixedDate,
      source: "waveshare-154",
      title: "Kupić baterię LiPo",
    }),
    "raw/inbox/2026-11-25T19-10-05Z-waveshare-154-kupic-baterie-lipo.md",
  );

  assert.equal(
    buildInboxPath({
      createdAt: fixedDate,
      source: "web",
      title: "Lista zadań",
      vaultPrefix: "/vault/",
    }),
    "vault/raw/inbox/2026-11-25T19-10-05Z-web-lista-zadan.md",
  );

  assert.equal(
    buildInboxPath({
      createdAt: fixedDate,
      source: "waveshare-154",
      title: "Notatka z pola",
      inboxDir: "/Inbox/",
    }),
    "Inbox/2026-11-25T19-10-05Z-waveshare-154-notatka-z-pola.md",
  );
});

test("buildCaptureMarkdown formats frontmatter and tasks", () => {
  const md = buildCaptureMarkdown({
    createdAt: new Date("2026-11-25T19:10:05Z"),
    source: "waveshare-154",
    type: "voice-note",
    title: "Test baterii",
    summary: "Sprawdzić pobór prądu w deep sleep",
    body: "Trzeba zmierzyć prąd na baterii LiPo.",
    tags: ["sprzet", "#pomysl"],
    tasks: ["Zmierzyć prąd w deep sleep", "- [ ] Zaktualizować notatkę"],
  });

  assert.match(md, /^---\ncreated_at: 2026-11-25T19:10:05Z/m);
  assert.match(md, /source: waveshare-154/);
  assert.match(md, /tags: \[inbox, sprzet, pomysl\]/);
  assert.match(md, /# Test baterii/);
  assert.match(md, /- \[ \] Zmierzyć prąd w deep sleep/);
  assert.match(md, /- \[ \] Zaktualizować notatkę/);
});

async function withTestServer(
  run: (baseUrl: string, committed: Array<{ path: string; content: string; commitMessage: string }>) => Promise<void>,
): Promise<void> {
  process.env.DEVICE_API_KEY = "test-device-key";
  process.env.GITHUB_VAULT_PREFIX = "";

  const committed: Array<{ path: string; content: string; commitMessage: string }> = [];
  const fixedNow = new Date("2026-11-25T19:15:00Z");

  const app = createApp({
    now: () => fixedNow,
    processAudio: async (audioBase64) => {
      assert.ok(audioBase64.length > 0);
      return {
        title: "Pomysł na notatkę głosową",
        summary: "Przetestować nagrywanie z ES8311",
        body: "Nagranie testowe z urządzenia Waveshare.",
        tags: ["audio", "pomysl"],
        tasks: ["Skonfigurować kodek ES8311"],
      };
    },
    commitToVault: async (params) => {
      committed.push(params);
      return { path: params.path, commitSha: "abc123def456" };
    },
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${addr.port}`, committed);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test("POST /api/capture enforces auth, validates input, and commits text + audio captures", async () => {
  await withTestServer(async (baseUrl, committed) => {
    // 1. Missing auth -> 401
    const unauth = await fetch(`${baseUrl}/api/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "web", text: "Hello" }),
    });
    assert.equal(unauth.status, 401);

    // 2. Invalid payload -> 400
    const bad = await fetch(`${baseUrl}/api/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "test-device-key",
      },
      body: JSON.stringify({ source: "waveshare-154" }),
    });
    assert.equal(bad.status, 400);

    // 3. Text capture -> 201
    const textRes = await fetch(`${baseUrl}/api/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "test-device-key",
      },
      body: JSON.stringify({
        source: "web",
        title: "Zakupy na weekend",
        text: "Kupić kawę\n- [ ] Mleko owsiane",
        tags: ["dom"],
      }),
    });
    assert.equal(textRes.status, 201);
    const textJson = (await textRes.json()) as Record<string, unknown>;
    assert.equal(textJson.ok, true);
    assert.equal(
      textJson.path,
      "raw/inbox/2026-11-25T19-15-00Z-web-zakupy-na-weekend.md",
    );
    assert.equal(committed.length, 1);
    assert.match(committed[0].content, /type: text-note/);
    assert.match(committed[0].content, /- \[ \] Mleko owsiane/);

    // 4. Audio WAV Base64 capture -> 201
    const fakeWavBase64 = Buffer.from("RIFFtestWAVpayload").toString("base64");
    const audioRes = await fetch(`${baseUrl}/api/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "test-device-key",
      },
      body: JSON.stringify({
        source: "waveshare-154",
        mimeType: "audio/wav",
        audioBase64: `data:audio/wav;base64,${fakeWavBase64}`,
      }),
    });
    assert.equal(audioRes.status, 201);
    const audioJson = (await audioRes.json()) as Record<string, unknown>;
    assert.equal(audioJson.ok, true);
    assert.equal(audioJson.commitSha, "abc123def456");
    assert.equal(committed.length, 2);
    assert.match(committed[1].content, /type: voice-note/);
    assert.match(committed[1].content, /## Zadania\n- \[ \] Skonfigurować kodek ES8311/);
  });
});
