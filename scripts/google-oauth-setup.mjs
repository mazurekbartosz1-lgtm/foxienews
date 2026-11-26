#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const SECRET_LOCAL_PATH = path.join(ROOT_DIR, "functions", ".secret.local");
const REDIRECT_URI = "http://127.0.0.1:8789/callback";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
];

function loadSecretLocal() {
  if (!fs.existsSync(SECRET_LOCAL_PATH)) return;
  for (const rawLine of fs.readFileSync(SECRET_LOCAL_PATH, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

function upsertSecretLocalEntries(entries) {
  let lines = fs.existsSync(SECRET_LOCAL_PATH)
    ? fs.readFileSync(SECRET_LOCAL_PATH, "utf8").split(/\r?\n/)
    : [];

  for (const [key, value] of Object.entries(entries)) {
    const encoded = `${key}=${JSON.stringify(value)}`;
    const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
    if (idx >= 0) {
      lines[idx] = encoded;
    } else {
      lines.push(encoded);
    }
  }

  const content = `${lines.filter((l, i, arr) => i < arr.length - 1 || l !== "").join("\n")}\n`;
  fs.writeFileSync(SECRET_LOCAL_PATH, content, "utf8");
}

async function main() {
  loadSecretLocal();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";

  if (!clientId) {
    clientId = (await rl.question("Podaj GOOGLE_CLIENT_ID (OAuth Desktop/Web client): ")).trim();
  }
  if (!clientSecret) {
    clientSecret = (await rl.question("Podaj GOOGLE_CLIENT_SECRET: ")).trim();
  }
  rl.close();

  if (!clientId || !clientSecret) {
    console.error("Brak GOOGLE_CLIENT_ID lub GOOGLE_CLIENT_SECRET.");
    process.exit(1);
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  console.log("\n1. Upewnij się, że w Google Cloud Console (OAuth Client) dodano Redirect URI:");
  console.log(`   ${REDIRECT_URI}`);
  console.log("\n2. Otwórz ten link w przeglądarce i zaakceptuj dostęp do Calendar + Tasks:\n");
  console.log(authUrl.toString());
  console.log("\nOczekiwanie na callback pod http://127.0.0.1:8789/callback ...\n");

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", REDIRECT_URI);
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const errParam = reqUrl.searchParams.get("error");
      const authCode = reqUrl.searchParams.get("code");
      if (errParam || !authCode) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h2>Błąd autoryzacji OAuth2</h2><p>Możesz zamknąć okno.</p>");
        server.close();
        reject(new Error(errParam || "Missing authorization code"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<h2>Autoryzacja Foxie Notes zakończona!</h2><p>Refresh token został zapisany lokalnie w <code>functions/.secret.local</code>. Możesz zamknąć to okno.</p>",
      );
      server.close();
      resolve(authCode);
    });

    server.listen(8789, "127.0.0.1");
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: String(code),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }).toString(),
  });

  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed (${tokenRes.status}): ${await tokenRes.text()}`);
  }

  const tokenJson = await tokenRes.json();
  if (!tokenJson.refresh_token) {
    throw new Error("Brak refresh_token w odpowiedzi Google (upewnij się, że użyto prompt=consent).");
  }

  upsertSecretLocalEntries({
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_REFRESH_TOKEN: tokenJson.refresh_token,
  });

  console.log("Zapisano GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET i GOOGLE_REFRESH_TOKEN do functions/.secret.local.");
  console.log("\nTeraz wgraj te 3 sekrety do Firebase Secret Manager (zostaniesz poproszony o wklejenie wartości):");
  console.log("  firebase functions:secrets:set GOOGLE_CLIENT_ID");
  console.log("  firebase functions:secrets:set GOOGLE_CLIENT_SECRET");
  console.log("  firebase functions:secrets:set GOOGLE_REFRESH_TOKEN");
  console.log("\nPo wgraniu dodaj je do secrets: [...] w functions/src/index.ts i uruchom firebase deploy --only functions.");
}

main().catch((err) => {
  console.error("[google-oauth-setup] ERROR:", err.message || err);
  process.exit(1);
});
