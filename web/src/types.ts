export interface WikiPageDoc {
  slug: string;
  title: string;
  path: string;
  markdown: string;
  plainText: string;
  summary?: string;
  tags: string[];
  updatedAt: string;
}

export interface WikiIndexEntry {
  slug: string;
  title: string;
  summary: string;
  tags: string[];
}

export interface WikiIndexDoc {
  entries: WikiIndexEntry[];
  updatedAt: string;
}

export interface TaskDoc {
  id: string;
  text: string;
  completed: boolean;
  sourcePath: string;
  sourceSlug?: string;
  dueDate?: string;
  priority?: string;
  tags?: string[];
  updatedAt: string;
}

export type NoteIntent =
  | "knowledge"
  | "project"
  | "plan-calendar"
  | "todo"
  | "research-idea"
  | "journal"
  | "vault-command";

export interface InboxJobDoc {
  id: string;
  inboxPath: string;
  processedPath?: string;
  status: "processing" | "done" | "error";
  intent?: NoteIntent;
  targetPath?: string;
  commitSha?: string;
  researchPrUrl?: string;
  researchPrNumber?: number;
  researchBranch?: string;
  researchReportPath?: string;
  googleEventIds?: string[];
  googleTaskIds?: string[];
  googleListsUsed?: string[];
  planningStatus?: "synced" | "skipped" | "error";
  vaultCommandSummary?: string;
  vaultCommandFiles?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CaptureResponse {
  ok: true;
  path: string;
  commitSha: string;
  title: string;
  summary: string;
}

export interface ResearchRunResponse {
  ok: boolean;
  status: "created" | "skipped" | "error";
  topicSlug: string;
  branch?: string;
  reportPath?: string;
  prNumber?: number;
  prUrl?: string;
  reason?: string;
}

export interface VaultCommandRunResponse {
  ok: boolean;
  status: "executed" | "skipped" | "error";
  summary: string;
  filesWritten: string[];
  filesDeleted?: string[];
  commitSha?: string;
  reason?: string;
}

export interface PlanRunResponse {
  ok: boolean;
  status: "synced" | "skipped" | "error";
  calendarEventsCreated: Array<{
    id: string;
    summary: string;
    htmlLink?: string;
    start: string;
  }>;
  tasksCreated: Array<{
    id: string;
    title: string;
    listName: string;
    due?: string;
  }>;
  listItemsCreated: Array<{
    id: string;
    title: string;
    listName: string;
  }>;
  skippedLowConfidenceEvents?: number;
  commitSha?: string;
  reason?: string;
}

export interface GardenerRunResponse {
  ok: boolean;
  status: "executed" | "skipped" | "error";
  summary: string;
  indexAdded: string[];
  indexRemoved: string[];
  filesUpdated: string[];
  commitSha?: string;
  reason?: string;
}

export interface WeeklyReviewRunResponse {
  ok: boolean;
  status: "created" | "skipped" | "error";
  weekKey: string;
  reportPath: string;
  summary: string;
  journalDaysIncluded: number;
  openTasksCount: number;
  commitSha?: string;
  reason?: string;
}

export interface ToggleTaskResponse {
  ok: true;
  sourcePath: string;
  text: string;
  completed: boolean;
  changed: boolean;
  commitSha?: string;
}
