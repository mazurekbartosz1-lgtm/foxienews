import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "./app.js";

function loadEnvFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, "utf8");

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;

    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
  return true;
}

function getLanIpv4Addresses(): string[] {
  const result: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        result.push(entry.address);
      }
    }
  }
  return result;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const functionsRoot = path.resolve(currentDir, "..");
const loadedEnv = loadEnvFile(path.join(functionsRoot, ".env"));
const loadedSecrets = loadEnvFile(path.join(functionsRoot, ".secret.local"));

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";

const requiredKeys = [
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "DEVICE_API_KEY",
];
const optionalKeys = ["GITHUB_WEBHOOK_SECRET", "ALLOWED_USER_EMAIL"];

app.listen(port, host, () => {
  console.log("[Foxie LAN Dev] Server listening");
  console.log(`  Local:   http://127.0.0.1:${port}/api/capture`);
  for (const ip of getLanIpv4Addresses()) {
    console.log(`  LAN:     http://${ip}:${port}/api/capture`);
  }
  console.log(
    `  Config:  .env=${loadedEnv ? "LOADED" : "MISSING"}, .secret.local=${loadedSecrets ? "LOADED" : "MISSING"}`,
  );
  for (const key of [...requiredKeys, ...optionalKeys]) {
    const isSet = Boolean(process.env[key]?.trim());
    console.log(`  ${key.padEnd(22)} ${isSet ? "SET" : "MISSING"}`);
  }
});
