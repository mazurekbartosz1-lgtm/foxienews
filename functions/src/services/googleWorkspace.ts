export interface GoogleTaskListSummary {
  id: string;
  title: string;
}

export interface GoogleTaskItem {
  id: string;
  title: string;
  status: "needsAction" | "completed";
  completed?: string;
  notes?: string;
  listId: string;
  listTitle: string;
}

export interface GoogleWorkspaceClient {
  isConfigured(): boolean;
  listTaskLists(): Promise<GoogleTaskListSummary[]>;
  listTasks?(params: {
    listId: string;
    listTitle?: string;
    showCompleted?: boolean;
    showHidden?: boolean;
  }): Promise<GoogleTaskItem[]>;
  ensureTaskList(listName: string): Promise<{
    id: string;
    title: string;
    created: boolean;
  }>;
  createTask(params: {
    listId: string;
    title: string;
    notes?: string;
    dueDate?: string;
  }): Promise<{ id: string; title: string }>;
  createCalendarEvent(params: {
    calendarId?: string;
    summary: string;
    description?: string;
    startIso: string;
    endIso: string;
    allDay?: boolean;
    location?: string;
    timeZone?: string;
  }): Promise<{ id: string; summary: string; htmlLink?: string }>;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TASKS_BASE_URL = "https://tasks.googleapis.com/tasks/v1";
const CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";

function readGoogleOAuthEnv() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim() ?? "";
  const calendarId = process.env.GOOGLE_CALENDAR_ID?.trim() || "primary";
  return { clientId, clientSecret, refreshToken, calendarId };
}

export function createGoogleWorkspaceClient(): GoogleWorkspaceClient {
  let cachedAccessToken = "";
  let cachedExpiresAtMs = 0;
  let cachedLists: GoogleTaskListSummary[] | null = null;

  async function getAccessToken(): Promise<string> {
    const { clientId, clientSecret, refreshToken } = readGoogleOAuthEnv();
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        "Missing Google OAuth2 configuration (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)",
      );
    }

    if (cachedAccessToken && Date.now() < cachedExpiresAtMs - 60_000) {
      return cachedAccessToken;
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Google OAuth2 token refresh failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) {
      throw new Error("Google OAuth2 response did not include access_token");
    }

    cachedAccessToken = data.access_token;
    cachedExpiresAtMs = Date.now() + (data.expires_in ?? 3600) * 1000;
    return cachedAccessToken;
  }

  async function authedJsonFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await getAccessToken();
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google API ${init.method ?? "GET"} ${url} -> ${res.status}: ${text}`);
    }

    return (await res.json()) as T;
  }

  async function listTaskListsInternal(): Promise<GoogleTaskListSummary[]> {
    const data = await authedJsonFetch<{
      items?: Array<{ id?: string; title?: string }>;
    }>(`${TASKS_BASE_URL}/users/@me/lists?maxResults=100`);

    const lists = (data.items ?? [])
      .filter((item): item is { id: string; title: string } => Boolean(item.id && item.title))
      .map((item) => ({ id: item.id, title: item.title }));

    cachedLists = lists;
    return lists;
  }

  return {
    isConfigured(): boolean {
      const { clientId, clientSecret, refreshToken } = readGoogleOAuthEnv();
      return Boolean(clientId && clientSecret && refreshToken);
    },

    async listTaskLists(): Promise<GoogleTaskListSummary[]> {
      return listTaskListsInternal();
    },

    async listTasks(params: {
      listId: string;
      listTitle?: string;
      showCompleted?: boolean;
      showHidden?: boolean;
    }): Promise<GoogleTaskItem[]> {
      const listId = params.listId || "@default";
      const query = new URLSearchParams({
        maxResults: "100",
        showCompleted: params.showCompleted === false ? "false" : "true",
        showHidden: params.showHidden === false ? "false" : "true",
      });
      const data = await authedJsonFetch<{
        items?: Array<{
          id?: string;
          title?: string;
          status?: string;
          completed?: string;
          notes?: string;
        }>;
      }>(`${TASKS_BASE_URL}/lists/${encodeURIComponent(listId)}/tasks?${query.toString()}`);

      const resolvedTitle =
        params.listTitle ??
        cachedLists?.find((l) => l.id === listId)?.title ??
        listId;

      return (data.items ?? [])
        .filter((item): item is { id: string; title: string; status?: string; completed?: string; notes?: string } =>
          Boolean(item.id && item.title),
        )
        .map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status === "completed" ? "completed" : "needsAction",
          ...(item.completed ? { completed: item.completed } : {}),
          ...(item.notes ? { notes: item.notes } : {}),
          listId,
          listTitle: resolvedTitle,
        }));
    },

    async ensureTaskList(listName: string): Promise<{
      id: string;
      title: string;
      created: boolean;
    }> {
      const cleanName = listName.trim();
      if (!cleanName || cleanName === "@default") {
        return { id: "@default", title: "Moje zadania", created: false };
      }

      const lists = cachedLists ?? (await listTaskListsInternal());
      const existing = lists.find(
        (l) => l.title.trim().toLowerCase() === cleanName.toLowerCase(),
      );
      if (existing) {
        return { id: existing.id, title: existing.title, created: false };
      }

      const created = await authedJsonFetch<{ id?: string; title?: string }>(
        `${TASKS_BASE_URL}/users/@me/lists`,
        {
          method: "POST",
          body: JSON.stringify({ title: cleanName }),
        },
      );

      if (!created.id) {
        throw new Error(`Failed to create Google Task list '${cleanName}'`);
      }

      const entry: GoogleTaskListSummary = {
        id: created.id,
        title: created.title ?? cleanName,
      };
      cachedLists = [...lists, entry];
      return { ...entry, created: true };
    },

    async createTask(params: {
      listId: string;
      title: string;
      notes?: string;
      dueDate?: string;
    }): Promise<{ id: string; title: string }> {
      const listId = encodeURIComponent(params.listId || "@default");
      const payload: Record<string, string> = {
        title: params.title.trim(),
      };
      if (params.notes?.trim()) {
        payload.notes = params.notes.trim();
      }
      if (params.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(params.dueDate.trim())) {
        payload.due = `${params.dueDate.trim()}T00:00:00.000Z`;
      }

      const created = await authedJsonFetch<{ id?: string; title?: string }>(
        `${TASKS_BASE_URL}/lists/${listId}/tasks`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );

      if (!created.id) {
        throw new Error(`Google Tasks create failed for '${params.title}'`);
      }

      return {
        id: created.id,
        title: created.title ?? params.title,
      };
    },

    async createCalendarEvent(params: {
      calendarId?: string;
      summary: string;
      description?: string;
      startIso: string;
      endIso: string;
      allDay?: boolean;
      location?: string;
      timeZone?: string;
    }): Promise<{ id: string; summary: string; htmlLink?: string }> {
      const { calendarId: defaultCal } = readGoogleOAuthEnv();
      const calendarId = encodeURIComponent(params.calendarId?.trim() || defaultCal);
      const timeZone = params.timeZone?.trim() || "Europe/Warsaw";

      const payload: Record<string, unknown> = {
        summary: params.summary.trim(),
      };
      if (params.description?.trim()) {
        payload.description = params.description.trim();
      }
      if (params.location?.trim()) {
        payload.location = params.location.trim();
      }

      if (params.allDay) {
        payload.start = { date: params.startIso.slice(0, 10) };
        payload.end = { date: params.endIso.slice(0, 10) };
      } else {
        payload.start = { dateTime: params.startIso, timeZone };
        payload.end = { dateTime: params.endIso, timeZone };
      }

      const created = await authedJsonFetch<{
        id?: string;
        summary?: string;
        htmlLink?: string;
      }>(`${CALENDAR_BASE_URL}/calendars/${calendarId}/events`, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (!created.id) {
        throw new Error(`Google Calendar create event failed for '${params.summary}'`);
      }

      return {
        id: created.id,
        summary: created.summary ?? params.summary,
        htmlLink: created.htmlLink,
      };
    },
  };
}
