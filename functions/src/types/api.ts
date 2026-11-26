export type CaptureSource = "waveshare-154" | "reterminal-e1001" | "web";

export interface CaptureRequest {
  source: CaptureSource;
  text?: string;
  audioBase64?: string;
  mimeType?: "audio/wav";
  title?: string;
  tags?: string[];
}

export interface CaptureResponse {
  ok: true;
  path: string;
  commitSha: string;
  title: string;
  summary: string;
}

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
  | "journal";

export type InboxJobStatus = "processing" | "done" | "error";

export interface InboxJobDoc {
  id: string;
  inboxPath: string;
  processedPath?: string;
  status: InboxJobStatus;
  intent?: NoteIntent;
  targetPath?: string;
  commitSha?: string;
  researchPrUrl?: string;
  researchPrNumber?: number;
  researchBranch?: string;
  researchReportPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchRunResult {
  status: "created" | "skipped" | "error";
  topicSlug: string;
  branch?: string;
  reportPath?: string;
  prNumber?: number;
  prUrl?: string;
  commitSha?: string;
  sourcesCount?: number;
  grounded?: boolean;
  reason?: string;
}

export interface OrganizeInboxResult {
  inboxPath: string;
  status: "processed" | "skipped" | "error";
  intent?: NoteIntent;
  targetPath?: string;
  processedPath?: string;
  commitSha?: string;
  research?: ResearchRunResult;
  reason?: string;
}
