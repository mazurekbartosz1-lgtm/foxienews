import cors from "cors";
import express from "express";
import { requireAuth } from "./middleware/auth";

export const app = express();

app.use(cors({ origin: true }));
// 15 MiB limit to accommodate Base64-encoded WAV recordings from ESP32-S3 PSRAM
app.use(express.json({ limit: "15mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "foxie-api" });
});

// Etap 1: Voice/text capture -> Gemini transcription/formatting -> GitHub raw/inbox/
app.post("/api/capture", requireAuth, (_req, res) => {
  res.status(501).json({
    error: "Not Implemented",
    stage: "Etap 1B",
    endpoint: "POST /api/capture",
  });
});

// Etap 2: Lightweight Wiki endpoints backed by Firestore cache
app.get("/api/wiki/index", requireAuth, (_req, res) => {
  res.status(501).json({
    error: "Not Implemented",
    stage: "Etap 2A",
    endpoint: "GET /api/wiki/index",
  });
});

app.get("/api/wiki/page/:slug", requireAuth, (_req, res) => {
  res.status(501).json({
    error: "Not Implemented",
    stage: "Etap 2A",
    endpoint: "GET /api/wiki/page/:slug",
  });
});

// Etap 2: GitHub push webhook (verified via X-Hub-Signature-256)
app.post("/api/webhook/github", (_req, res) => {
  res.status(501).json({
    error: "Not Implemented",
    stage: "Etap 2A",
    endpoint: "POST /api/webhook/github",
  });
});
