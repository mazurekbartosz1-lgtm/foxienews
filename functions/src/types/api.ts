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
