import { initializeApp } from "firebase-admin/app";
import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { app } from "./app.js";
import { createFirestoreVaultStore } from "./services/firestoreStore.js";
import { runGardenerAgent } from "./services/gardenerAgent.js";
import { createGitHubVaultClient } from "./services/github.js";
import { organizePendingInboxFiles } from "./services/inboxOrganizer.js";
import { runWeeklyReviewAgent } from "./services/weeklyReviewAgent.js";

initializeApp();

const githubToken = defineSecret("GITHUB_TOKEN");
const geminiApiKey = defineSecret("GEMINI_API_KEY");
const deviceApiKey = defineSecret("DEVICE_API_KEY");
const githubWebhookSecret = defineSecret("GITHUB_WEBHOOK_SECRET");
const allowedUserEmail = defineSecret("ALLOWED_USER_EMAIL");
const googleClientId = defineSecret("GOOGLE_CLIENT_ID");
const googleClientSecret = defineSecret("GOOGLE_CLIENT_SECRET");
const googleRefreshToken = defineSecret("GOOGLE_REFRESH_TOKEN");

export const api = onRequest(
  {
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 180,
    secrets: [
      githubToken,
      geminiApiKey,
      deviceApiKey,
      githubWebhookSecret,
      allowedUserEmail,
      googleClientId,
      googleClientSecret,
      googleRefreshToken,
    ],
  },
  app,
);

export const inboxSweeper = onSchedule(
  {
    schedule: "every 5 minutes",
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 300,
    maxInstances: 1,
    secrets: [
      githubToken,
      geminiApiKey,
      googleClientId,
      googleClientSecret,
      googleRefreshToken,
    ],
  },
  async () => {
    const vaultClient = createGitHubVaultClient();
    const store = createFirestoreVaultStore();
    const result = await organizePendingInboxFiles({
      vaultClient,
      store,
      vaultPrefix: process.env.GITHUB_VAULT_PREFIX,
      limit: 10,
      maxAttempts: 3,
    });
    if (result.processed > 0 || result.errors > 0 || result.skipped > 0) {
      console.log(
        `[inboxSweeper] processed=${result.processed} skipped=${result.skipped} errors=${result.errors}`,
      );
    }
  },
);

export const weeklyGardener = onSchedule(
  {
    schedule: "0 4 * * 0",
    timeZone: "Europe/Warsaw",
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 300,
    maxInstances: 1,
    secrets: [githubToken, geminiApiKey],
  },
  async () => {
    const vaultClient = createGitHubVaultClient();
    const result = await runGardenerAgent({
      vaultClient,
      vaultPrefix: process.env.GITHUB_VAULT_PREFIX,
    });
    console.log(
      `[weeklyGardener] status=${result.status} added=${result.indexAdded.length} removed=${result.indexRemoved.length} updated=${result.filesUpdated.length}`,
    );
  },
);

export const weeklyReview = onSchedule(
  {
    schedule: "0 19 * * 0",
    timeZone: "Europe/Warsaw",
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 300,
    maxInstances: 1,
    secrets: [githubToken, geminiApiKey],
  },
  async () => {
    const vaultClient = createGitHubVaultClient();
    const result = await runWeeklyReviewAgent({
      vaultClient,
      vaultPrefix: process.env.GITHUB_VAULT_PREFIX,
    });
    console.log(
      `[weeklyReview] status=${result.status} week=${result.weekKey} path=${result.reportPath} days=${result.journalDaysIncluded} openTasks=${result.openTasksCount}`,
    );
  },
);
