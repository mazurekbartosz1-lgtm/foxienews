import { GoogleGenAI } from "@google/genai";
import type { PlanningRunResult } from "../types/api.js";
import type { GitHubVaultClient } from "./github.js";
import type { GoogleWorkspaceClient } from "./googleWorkspace.js";

export const CALENDAR_CONFIDENCE_THRESHOLD = 0.75;

export interface PlannedCalendarEvent {
  summary: string;
  description?: string;
  startIso: string;
  endIso?: string;
  allDay?: boolean;
  location?: string;
  confidence: number;
}

export interface PlannedTaskItem {
  title: string;
  notes?: string;
  dueDate?: string;
  listName?: string;
}

export interface PlannedListItem {
  listName: string;
  title: string;
  notes?: string;
}

export interface PlanningDecision {
  calendarEvents: PlannedCalendarEvent[];
  tasks: PlannedTaskItem[];
  listItems: PlannedListItem[];
}

export type ExtractPlanFn = (params: {
  topicTitle: string;
  noteMarkdown: string;
  nowIso: string;
  existingListNames: string[];
}) => Promise<PlanningDecision>;

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }
  return trimmed;
}

function formatWarsawNowContext(now: Date): string {
  const formatter = new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${formatter.format(now)} (ISO UTC: ${now.toISOString()})`;
}

function addDaysToYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map((part) => Number.parseInt(part, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function normalizeEventTimes(ev: PlannedCalendarEvent): {
  startIso: string;
  endIso: string;
  allDay: boolean;
} | null {
  const rawStart = ev.startIso?.trim() ?? "";
  if (!rawStart) return null;

  if (ev.allDay || /^\d{4}-\d{2}-\d{2}$/.test(rawStart)) {
    const startYmd = rawStart.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startYmd)) return null;
    const rawEndYmd = ev.endIso?.trim().slice(0, 10) ?? "";
    const endYmd =
      /^\d{4}-\d{2}-\d{2}$/.test(rawEndYmd) && rawEndYmd > startYmd
        ? rawEndYmd
        : addDaysToYmd(startYmd, 1);
    return { startIso: startYmd, endIso: endYmd, allDay: true };
  }

  const parsedStart = Date.parse(rawStart);
  if (Number.isNaN(parsedStart)) {
    return null;
  }

  let endIso = ev.endIso?.trim() ?? "";
  const parsedEnd = endIso ? Date.parse(endIso) : Number.NaN;
  if (Number.isNaN(parsedEnd) || parsedEnd <= parsedStart) {
    // Keep original offset when present or build UTC+60m ISO
    endIso = new Date(parsedStart + 60 * 60 * 1000).toISOString();
  }

  return { startIso: rawStart, endIso, allDay: false };
}

export async function extractPlanWithGemini(params: {
  topicTitle: string;
  noteMarkdown: string;
  nowIso: string;
  existingListNames: string[];
}): Promise<PlanningDecision> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY configuration");
  }

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";
  const ai = new GoogleGenAI({ apiKey });
  const nowDate = new Date(params.nowIso);
  const warsawContext = formatWarsawNowContext(
    Number.isNaN(nowDate.getTime()) ? new Date() : nowDate,
  );

  const listsInfo =
    params.existingListNames.length > 0
      ? params.existingListNames.map((n) => `- ${n}`).join("\n")
      : "- Moje zadania (@default)";

  const prompt = `Jesteś Agentem Planowania prywatnego asystenta Foxie Notes.
Przekształcasz notatkę użytkownika na konkretne wpisy w **Google Calendar**, **Google Tasks** oraz tematyczne **Google Listy** (np. "Lista zakupów", "Lista pakowania", "Do załatwienia - Auto").

BIEŻĄCA DATA I CZAS (strefa Europe/Warsaw): ${warsawContext}

ISTNIEJĄCE LISTY GOOGLE TASKS UŻYTKOWNIKA:
${listsInfo}

TYTUŁ NOTATKI: ${params.topicTitle}
TREŚĆ NOTATKI:
\`\`\`markdown
${params.noteMarkdown}
\`\`\`

ZASADY:
1. **calendarEvents**:
   - Dodawaj TYLKO wtedy, gdy w notatce jest wyraźnie zaplanowane spotkanie, wizyta lub termin czasowy (np. "w środę o 12:00", "jutro o 9:30", "15 grudnia").
   - Ustaw \`confidence\` (0.0–1.0): >= 0.80 gdy data/godzina lub konkretny dzień są jednoznaczne; <= 0.50 gdy to luźna myśl bez terminu.
   - Format \`startIso\` / \`endIso\`: pełny ISO z offsetem lokalnym (np. \`2026-12-02T12:00:00+01:00\`) lub \`YYYY-MM-DD\` dla \`allDay: true\`. Jeśli brak czasu trwania, przyjmij 60 minut.
2. **tasks**:
   - Konkretne zadania do wykonania ("zadzwonić do Toyoty", "wysłać fakturę"), z opcjonalnym \`dueDate\` (\`YYYY-MM-DD\`) jeśli podano termin.
   - \`listName\` opcjonalne (puste lub \`"@default"\` dla głównej listy zadań).
3. **listItems**:
   - Pozycje listowe (produkty na zakupy, lista rzeczy do spakowania, pozycje do odhaczenia na dedykowanej liście tematycznej), z konkretnym \`listName\` (np. \`"Lista zakupów"\` — reużywaj istniejącą nazwę listy jeśli pasuje!).
4. Nie wymyślaj wydarzeń ani pozycji, których nie ma w notatce. Zwróć WYŁĄCZNIE poprawny JSON:
{
  "calendarEvents": [
    {
      "summary": "Krótki tytuł wydarzenia",
      "description": "Opcjonalny opis",
      "startIso": "2026-12-02T12:00:00+01:00",
      "endIso": "2026-12-02T13:00:00+01:00",
      "allDay": false,
      "location": "Opcjonalne miejsce",
      "confidence": 0.9
    }
  ],
  "tasks": [
    {
      "title": "Treść zadania",
      "notes": "Opcjonalna notatka",
      "dueDate": "YYYY-MM-DD",
      "listName": "@default"
    }
  ],
  "listItems": [
    {
      "listName": "Lista zakupów",
      "title": "Nazwa pozycji na liście",
      "notes": "Opcjonalna uwaga"
    }
  ]
}`;

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
    },
  });

  const rawText = response.text?.trim() ?? "";
  if (!rawText) {
    throw new Error("Gemini planner returned an empty response");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFences(rawText)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Gemini planner returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rawEvents = Array.isArray(parsed.calendarEvents) ? parsed.calendarEvents : [];
  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const rawListItems = Array.isArray(parsed.listItems) ? parsed.listItems : [];

  const calendarEvents: PlannedCalendarEvent[] = rawEvents
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      summary: typeof item.summary === "string" ? item.summary.trim() : "",
      description: typeof item.description === "string" ? item.description.trim() : undefined,
      startIso: typeof item.startIso === "string" ? item.startIso.trim() : "",
      endIso: typeof item.endIso === "string" ? item.endIso.trim() : undefined,
      allDay: Boolean(item.allDay),
      location: typeof item.location === "string" ? item.location.trim() : undefined,
      confidence: typeof item.confidence === "number" ? item.confidence : 0,
    }))
    .filter((ev) => Boolean(ev.summary && ev.startIso));

  const tasks: PlannedTaskItem[] = rawTasks
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      title: typeof item.title === "string" ? item.title.trim() : "",
      notes: typeof item.notes === "string" ? item.notes.trim() : undefined,
      dueDate:
        typeof item.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate.trim())
          ? item.dueDate.trim()
          : undefined,
      listName: typeof item.listName === "string" ? item.listName.trim() : undefined,
    }))
    .filter((t) => Boolean(t.title));

  const listItems: PlannedListItem[] = rawListItems
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      listName: typeof item.listName === "string" ? item.listName.trim() : "Lista",
      title: typeof item.title === "string" ? item.title.trim() : "",
      notes: typeof item.notes === "string" ? item.notes.trim() : undefined,
    }))
    .filter((li) => Boolean(li.listName && li.title));

  return { calendarEvents, tasks, listItems };
}

function appendGoogleSyncSection(params: {
  existingMarkdown: string;
  updatedAtIso: string;
  result: PlanningRunResult;
}): string {
  const normalized = params.existingMarkdown.replace(/\r\n/g, "\n").trimEnd();
  const lines: string[] = ["", "## Synchronizacja Google", `- Zsynchronizowano: ${params.updatedAtIso}`];

  for (const ev of params.result.calendarEventsCreated) {
    lines.push(
      `- Kalendarz: **${ev.summary}** (${ev.start}, id: \`${ev.id}\`)${ev.htmlLink ? ` — [otwórz](${ev.htmlLink})` : ""}`,
    );
  }
  for (const task of params.result.tasksCreated) {
    lines.push(
      `- Google Tasks (${task.listName}): **${task.title}**${task.due ? ` (@due(${task.due}))` : ""} (id: \`${task.id}\`)`,
    );
  }
  for (const item of params.result.listItemsCreated) {
    lines.push(`- Google Lista (${item.listName}): **${item.title}** (id: \`${item.id}\`)`);
  }

  return `${normalized}\n${lines.join("\n")}\n`;
}

export async function runPlanningAgent(params: {
  topicTitle: string;
  noteMarkdown: string;
  sourcePath?: string;
  targetRepoPath?: string;
  googleClient: GoogleWorkspaceClient;
  vaultClient?: GitHubVaultClient;
  extractPlan?: ExtractPlanFn;
  now?: () => Date;
}): Promise<PlanningRunResult> {
  if (!params.googleClient.isConfigured()) {
    return {
      status: "skipped",
      calendarEventsCreated: [],
      tasksCreated: [],
      listItemsCreated: [],
      reason: "google_oauth_not_configured",
    };
  }

  const getNow = params.now ?? (() => new Date());
  const nowIso = getNow().toISOString().replace(/\.\d{3}Z$/, "Z");
  const extractPlan = params.extractPlan ?? extractPlanWithGemini;

  let existingListNames: string[] = [];
  try {
    const lists = await params.googleClient.listTaskLists();
    existingListNames = lists.map((l) => l.title);
  } catch {
    existingListNames = [];
  }

  const decision = await extractPlan({
    topicTitle: params.topicTitle,
    noteMarkdown: params.noteMarkdown,
    nowIso,
    existingListNames,
  });

  const calendarEventsCreated: PlanningRunResult["calendarEventsCreated"] = [];
  const tasksCreated: PlanningRunResult["tasksCreated"] = [];
  const listItemsCreated: PlanningRunResult["listItemsCreated"] = [];
  let skippedLowConfidenceEvents = 0;

  for (const ev of decision.calendarEvents) {
    if (ev.confidence < CALENDAR_CONFIDENCE_THRESHOLD) {
      skippedLowConfidenceEvents++;
      continue;
    }
    const normalizedTimes = normalizeEventTimes(ev);
    if (!normalizedTimes) {
      skippedLowConfidenceEvents++;
      continue;
    }

    const descriptionParts = [ev.description?.trim() ?? ""];
    if (params.sourcePath) {
      descriptionParts.push(`Źródło Foxie Notes: ${params.sourcePath}`);
    }
    const description = descriptionParts.filter(Boolean).join("\n\n");

    const created = await params.googleClient.createCalendarEvent({
      summary: ev.summary,
      description,
      startIso: normalizedTimes.startIso,
      endIso: normalizedTimes.endIso,
      allDay: normalizedTimes.allDay,
      location: ev.location,
      timeZone: "Europe/Warsaw",
    });

    calendarEventsCreated.push({
      id: created.id,
      summary: created.summary,
      htmlLink: created.htmlLink,
      start: normalizedTimes.startIso,
    });
  }

  const resolvedLists = new Map<string, { id: string; title: string }>();
  async function resolveList(name?: string): Promise<{ id: string; title: string }> {
    const clean = name?.trim() ?? "";
    if (!clean || clean === "@default") {
      return { id: "@default", title: "Moje zadania" };
    }
    const key = clean.toLowerCase();
    const cached = resolvedLists.get(key);
    if (cached) return cached;
    const ensured = await params.googleClient.ensureTaskList(clean);
    const entry = { id: ensured.id, title: ensured.title };
    resolvedLists.set(key, entry);
    return entry;
  }

  for (const task of decision.tasks) {
    const targetList = await resolveList(task.listName);
    const notesParts = [task.notes?.trim() ?? ""];
    if (params.sourcePath) {
      notesParts.push(`Źródło: ${params.sourcePath}`);
    }
    const created = await params.googleClient.createTask({
      listId: targetList.id,
      title: task.title,
      notes: notesParts.filter(Boolean).join("\n"),
      dueDate: task.dueDate,
    });
    tasksCreated.push({
      id: created.id,
      title: created.title,
      listName: targetList.title,
      due: task.dueDate,
    });
  }

  for (const item of decision.listItems) {
    const targetList = await resolveList(item.listName);
    const created = await params.googleClient.createTask({
      listId: targetList.id,
      title: item.title,
      notes: item.notes,
    });
    listItemsCreated.push({
      id: created.id,
      title: created.title,
      listName: targetList.title,
    });
  }

  const totalCreated =
    calendarEventsCreated.length + tasksCreated.length + listItemsCreated.length;

  const result: PlanningRunResult = {
    status: "synced",
    calendarEventsCreated,
    tasksCreated,
    listItemsCreated,
    ...(skippedLowConfidenceEvents > 0 ? { skippedLowConfidenceEvents } : {}),
  };

  if (totalCreated > 0 && params.targetRepoPath && params.vaultClient) {
    const existingWiki = await params.vaultClient.fetchFile(params.targetRepoPath);
    if (existingWiki !== null) {
      const updatedWiki = appendGoogleSyncSection({
        existingMarkdown: existingWiki,
        updatedAtIso: nowIso,
        result,
      });
      const commitRes = await params.vaultClient.commitAtomicChanges({
        changes: [{ path: params.targetRepoPath, content: updatedWiki }],
        commitMessage: `agent(planner): ${params.topicTitle}`,
      });
      result.commitSha = commitRes.commitSha;
    }
  }

  return result;
}
