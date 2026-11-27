import { initializeApp } from "firebase-admin/app";
import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { app } from "./app.js";

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
