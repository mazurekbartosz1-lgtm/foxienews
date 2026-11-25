import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getAuth } from "firebase-admin/auth";

export interface AuthenticatedRequest extends Request {
  authContext?: {
    kind: "device" | "user";
    email?: string;
  };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Authorizes either:
 * 1) Hardware devices via X-API-Key (compared against DEVICE_API_KEY secret)
 * 2) Web users via Authorization: Bearer <Firebase ID Token>, restricted to ALLOWED_USER_EMAIL
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const apiKeyHeader = req.header("x-api-key");
  const expectedDeviceKey = process.env.DEVICE_API_KEY ?? "";

  if (apiKeyHeader) {
    if (expectedDeviceKey && safeEqual(apiKeyHeader, expectedDeviceKey)) {
      req.authContext = { kind: "device" };
      next();
      return;
    }
    res.status(401).json({ error: "Invalid device API key" });
    return;
  }

  const authHeader = req.header("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing authentication credentials" });
    return;
  }

  const idToken = authHeader.slice("Bearer ".length).trim();
  const allowedEmail = process.env.ALLOWED_USER_EMAIL ?? "";

  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    if (!decoded.email_verified || !decoded.email || decoded.email !== allowedEmail) {
      res.status(403).json({ error: "User is not authorized" });
      return;
    }
    req.authContext = { kind: "user", email: decoded.email };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired Firebase ID token" });
  }
}
