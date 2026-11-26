import crypto from "node:crypto";
import { getFirestore } from "firebase-admin/firestore";
import type { InboxJobDoc, TaskDoc, WikiIndexDoc, WikiPageDoc } from "../types/api.js";
import { normalizeSlug, slugToDocId } from "./wikiParser.js";

const COLLECTION_WIKI_PAGES = "wiki_pages";
const COLLECTION_WIKI_META = "wiki_meta";
const DOC_WIKI_INDEX = "index";
const COLLECTION_TASKS = "tasks";
const COLLECTION_INBOX_JOBS = "inbox_jobs";
const FIRESTORE_BATCH_LIMIT = 450;
const DEFAULT_JOB_STALE_AFTER_MS = 5 * 60 * 1000;

export function inboxPathToJobId(inboxPath: string): string {
  return crypto.createHash("sha1").update(inboxPath).digest("hex").slice(0, 20);
}

export interface VaultStore {
  upsertWikiPage(page: WikiPageDoc): Promise<void>;
  deleteWikiPage(slug: string): Promise<void>;
  getWikiPage(slug: string): Promise<WikiPageDoc | null>;
  listWikiPages(): Promise<WikiPageDoc[]>;
  getWikiIndex(): Promise<WikiIndexDoc | null>;
  saveWikiIndex(index: WikiIndexDoc): Promise<void>;
  replaceTasksForSource(sourcePath: string, tasks: TaskDoc[]): Promise<void>;
  deleteTasksForSource(sourcePath: string): Promise<void>;
  getInboxJob(inboxPath: string): Promise<InboxJobDoc | null>;
  claimInboxJob(params: {
    inboxPath: string;
    nowIso: string;
    staleAfterMs?: number;
    force?: boolean;
  }): Promise<{ claimed: boolean; existing?: InboxJobDoc }>;
  completeInboxJob(job: InboxJobDoc): Promise<void>;
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  ) as T;
}

export function createFirestoreVaultStore(): VaultStore {
  const db = () => getFirestore();

  async function commitBatchedOps(
    ops: Array<(batch: FirebaseFirestore.WriteBatch) => void>,
  ): Promise<void> {
    for (let i = 0; i < ops.length; i += FIRESTORE_BATCH_LIMIT) {
      const batch = db().batch();
      for (const op of ops.slice(i, i + FIRESTORE_BATCH_LIMIT)) {
        op(batch);
      }
      await batch.commit();
    }
  }

  return {
    async upsertWikiPage(page: WikiPageDoc): Promise<void> {
      const docId = slugToDocId(page.slug);
      await db()
        .collection(COLLECTION_WIKI_PAGES)
        .doc(docId)
        .set(stripUndefined(page));
    },

    async deleteWikiPage(slug: string): Promise<void> {
      const docId = slugToDocId(slug);
      await db().collection(COLLECTION_WIKI_PAGES).doc(docId).delete();
    },

    async getWikiPage(slug: string): Promise<WikiPageDoc | null> {
      const docId = slugToDocId(slug);
      const snap = await db().collection(COLLECTION_WIKI_PAGES).doc(docId).get();
      if (!snap.exists) return null;
      return snap.data() as WikiPageDoc;
    },

    async listWikiPages(): Promise<WikiPageDoc[]> {
      const snap = await db().collection(COLLECTION_WIKI_PAGES).get();
      return snap.docs.map((doc) => doc.data() as WikiPageDoc);
    },

    async getWikiIndex(): Promise<WikiIndexDoc | null> {
      const snap = await db()
        .collection(COLLECTION_WIKI_META)
        .doc(DOC_WIKI_INDEX)
        .get();
      if (!snap.exists) return null;
      return snap.data() as WikiIndexDoc;
    },

    async saveWikiIndex(index: WikiIndexDoc): Promise<void> {
      await db()
        .collection(COLLECTION_WIKI_META)
        .doc(DOC_WIKI_INDEX)
        .set(stripUndefined(index));
    },

    async replaceTasksForSource(sourcePath: string, tasks: TaskDoc[]): Promise<void> {
      const existingSnap = await db()
        .collection(COLLECTION_TASKS)
        .where("sourcePath", "==", sourcePath)
        .get();

      const nextIds = new Set(tasks.map((t) => t.id));
      const ops: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [];

      for (const doc of existingSnap.docs) {
        if (!nextIds.has(doc.id)) {
          ops.push((batch) => batch.delete(doc.ref));
        }
      }
      for (const task of tasks) {
        const ref = db().collection(COLLECTION_TASKS).doc(task.id);
        ops.push((batch) => batch.set(ref, stripUndefined(task)));
      }

      if (ops.length > 0) {
        await commitBatchedOps(ops);
      }
    },

    async deleteTasksForSource(sourcePath: string): Promise<void> {
      const existingSnap = await db()
        .collection(COLLECTION_TASKS)
        .where("sourcePath", "==", sourcePath)
        .get();

      if (existingSnap.empty) return;
      const ops = existingSnap.docs.map(
        (doc) => (batch: FirebaseFirestore.WriteBatch) => batch.delete(doc.ref),
      );
      await commitBatchedOps(ops);
    },

    async getInboxJob(inboxPath: string): Promise<InboxJobDoc | null> {
      const id = inboxPathToJobId(inboxPath);
      const snap = await db().collection(COLLECTION_INBOX_JOBS).doc(id).get();
      if (!snap.exists) return null;
      return snap.data() as InboxJobDoc;
    },

    async claimInboxJob(params: {
      inboxPath: string;
      nowIso: string;
      staleAfterMs?: number;
      force?: boolean;
    }): Promise<{ claimed: boolean; existing?: InboxJobDoc }> {
      const id = inboxPathToJobId(params.inboxPath);
      const ref = db().collection(COLLECTION_INBOX_JOBS).doc(id);
      const staleAfterMs = params.staleAfterMs ?? DEFAULT_JOB_STALE_AFTER_MS;
      const nowMs = Date.parse(params.nowIso);

      return db().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const existing = snap.exists ? (snap.data() as InboxJobDoc) : undefined;

        if (existing) {
          if (existing.status === "done" && !params.force) {
            return { claimed: false, existing };
          }
          if (existing.status === "processing" && !params.force) {
            const updatedMs = Date.parse(existing.updatedAt);
            if (!Number.isNaN(nowMs) && !Number.isNaN(updatedMs) && nowMs - updatedMs < staleAfterMs) {
              return { claimed: false, existing };
            }
          }
        }

        const nextJob: InboxJobDoc = {
          id,
          inboxPath: params.inboxPath,
          status: "processing",
          createdAt: existing?.createdAt ?? params.nowIso,
          updatedAt: params.nowIso,
        };
        tx.set(ref, stripUndefined(nextJob));
        return { claimed: true, existing };
      });
    },

    async completeInboxJob(job: InboxJobDoc): Promise<void> {
      const id = job.id || inboxPathToJobId(job.inboxPath);
      await db()
        .collection(COLLECTION_INBOX_JOBS)
        .doc(id)
        .set(stripUndefined({ ...job, id }));
    },
  };
}

export function createInMemoryVaultStore(): VaultStore & {
  getAllTasks(): TaskDoc[];
  getAllInboxJobs(): InboxJobDoc[];
} {
  const pages = new Map<string, WikiPageDoc>();
  const tasks = new Map<string, TaskDoc>();
  const inboxJobs = new Map<string, InboxJobDoc>();
  let indexDoc: WikiIndexDoc | null = null;

  return {
    async upsertWikiPage(page: WikiPageDoc): Promise<void> {
      pages.set(normalizeSlug(page.slug), structuredClone(page));
    },

    async deleteWikiPage(slug: string): Promise<void> {
      pages.delete(normalizeSlug(slug));
    },

    async getWikiPage(slug: string): Promise<WikiPageDoc | null> {
      const found = pages.get(normalizeSlug(slug));
      return found ? structuredClone(found) : null;
    },

    async listWikiPages(): Promise<WikiPageDoc[]> {
      return Array.from(pages.values()).map((p) => structuredClone(p));
    },

    async getWikiIndex(): Promise<WikiIndexDoc | null> {
      return indexDoc ? structuredClone(indexDoc) : null;
    },

    async saveWikiIndex(index: WikiIndexDoc): Promise<void> {
      indexDoc = structuredClone(index);
    },

    async replaceTasksForSource(sourcePath: string, nextTasks: TaskDoc[]): Promise<void> {
      for (const [id, task] of tasks.entries()) {
        if (task.sourcePath === sourcePath) {
          tasks.delete(id);
        }
      }
      for (const task of nextTasks) {
        tasks.set(task.id, structuredClone(task));
      }
    },

    async deleteTasksForSource(sourcePath: string): Promise<void> {
      for (const [id, task] of tasks.entries()) {
        if (task.sourcePath === sourcePath) {
          tasks.delete(id);
        }
      }
    },

    async getInboxJob(inboxPath: string): Promise<InboxJobDoc | null> {
      const found = inboxJobs.get(inboxPathToJobId(inboxPath));
      return found ? structuredClone(found) : null;
    },

    async claimInboxJob(params: {
      inboxPath: string;
      nowIso: string;
      staleAfterMs?: number;
      force?: boolean;
    }): Promise<{ claimed: boolean; existing?: InboxJobDoc }> {
      const id = inboxPathToJobId(params.inboxPath);
      const existing = inboxJobs.get(id);
      const staleAfterMs = params.staleAfterMs ?? DEFAULT_JOB_STALE_AFTER_MS;
      const nowMs = Date.parse(params.nowIso);

      if (existing) {
        if (existing.status === "done" && !params.force) {
          return { claimed: false, existing: structuredClone(existing) };
        }
        if (existing.status === "processing" && !params.force) {
          const updatedMs = Date.parse(existing.updatedAt);
          if (!Number.isNaN(nowMs) && !Number.isNaN(updatedMs) && nowMs - updatedMs < staleAfterMs) {
            return { claimed: false, existing: structuredClone(existing) };
          }
        }
      }

      const nextJob: InboxJobDoc = {
        id,
        inboxPath: params.inboxPath,
        status: "processing",
        createdAt: existing?.createdAt ?? params.nowIso,
        updatedAt: params.nowIso,
      };
      inboxJobs.set(id, structuredClone(nextJob));
      return { claimed: true, existing: existing ? structuredClone(existing) : undefined };
    },

    async completeInboxJob(job: InboxJobDoc): Promise<void> {
      const id = job.id || inboxPathToJobId(job.inboxPath);
      inboxJobs.set(id, structuredClone({ ...job, id }));
    },

    getAllTasks(): TaskDoc[] {
      return Array.from(tasks.values()).map((t) => structuredClone(t));
    },

    getAllInboxJobs(): InboxJobDoc[] {
      return Array.from(inboxJobs.values()).map((j) => structuredClone(j));
    },
  };
}
