import { getFirestore } from "firebase-admin/firestore";
import type { TaskDoc, WikiIndexDoc, WikiPageDoc } from "../types/api.js";
import { normalizeSlug, slugToDocId } from "./wikiParser.js";

const COLLECTION_WIKI_PAGES = "wiki_pages";
const COLLECTION_WIKI_META = "wiki_meta";
const DOC_WIKI_INDEX = "index";
const COLLECTION_TASKS = "tasks";
const FIRESTORE_BATCH_LIMIT = 450;

export interface VaultStore {
  upsertWikiPage(page: WikiPageDoc): Promise<void>;
  deleteWikiPage(slug: string): Promise<void>;
  getWikiPage(slug: string): Promise<WikiPageDoc | null>;
  listWikiPages(): Promise<WikiPageDoc[]>;
  getWikiIndex(): Promise<WikiIndexDoc | null>;
  saveWikiIndex(index: WikiIndexDoc): Promise<void>;
  replaceTasksForSource(sourcePath: string, tasks: TaskDoc[]): Promise<void>;
  deleteTasksForSource(sourcePath: string): Promise<void>;
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
  };
}

export function createInMemoryVaultStore(): VaultStore & {
  getAllTasks(): TaskDoc[];
} {
  const pages = new Map<string, WikiPageDoc>();
  const tasks = new Map<string, TaskDoc>();
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

    getAllTasks(): TaskDoc[] {
      return Array.from(tasks.values()).map((t) => structuredClone(t));
    },
  };
}
