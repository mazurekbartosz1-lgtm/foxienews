import { GoogleGenAI } from "@google/genai";

export interface ProcessedCapture {
  title: string;
  summary: string;
  body: string;
  tags: string[];
  tasks: string[];
}

const AUDIO_SYSTEM_PROMPT = `Jesteś asystentem prywatnego vaulta Obsidian (LLM Wiki).
Otrzymujesz nagranie głosowe użytkownika (zwykle po polsku, czasem z wtrąceniami po angielsku).
Dokonaj dokładnej transkrypcji i sformatuj treść jako zwięzłą notatkę Markdown gotową do Obsidiana.
Zachowaj wszystkie konkretne fakty, nazwy, kwoty i daty.

Zwróć WYŁĄCZNIE poprawny obiekt JSON (bez dodatkowego tekstu) o polach:
{
  "title": "Krótki, konkretny tytuł notatki (max 8 słów)",
  "summary": "1 krótkie zdanie podsumowujące notatkę (max 140 znaków, czytelne na małym e-inku)",
  "body": "Uporządkowana, zwięzła treść notatki w Markdown (akapity lub krótkie punkty, bez sekcji Zadania)",
  "tags": ["1-4 krótkie tagi bez # i bez spacji, np. pomysl, sprzet"],
  "tasks": ["konkretne zadania do wykonania wyciągnięte z nagrania (bez prefiksu '- [ ]'); konsoliduj ściśle powiązane kroki jednej sprawy w JEDNO konkretne zadanie (np. zamiast osobno 'Znaleźć numer do X' i 'Zadzwonić do X o 15:00', utwórz jedno zadanie 'Zadzwonić do X o 15:00 (znaleźć numer telefonu)'); rozdzielaj wyłącznie niezależne sprawy; jeśli padł konkretny termin, dopisz na końcu zadania @due(YYYY-MM-DD); pusta tablica jeśli brak"]
}`;

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

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function processAudioWithGemini(
  audioBase64: string,
  mimeType = "audio/wav",
): Promise<ProcessedCapture> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY configuration");
  }

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType,
              data: audioBase64,
            },
          },
          {
            text: AUDIO_SYSTEM_PROMPT,
          },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
    },
  });

  const rawText = response.text?.trim() ?? "";
  if (!rawText) {
    throw new Error("Gemini returned an empty response");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFences(rawText)) as Record<string, unknown>;
  } catch {
    // Fallback if model returned plain text instead of strict JSON
    return processTextCapture(rawText, "Notatka głosowa");
  }

  const title =
    typeof parsed.title === "string" && parsed.title.trim()
      ? parsed.title.trim()
      : "Notatka głosowa";
  const body =
    typeof parsed.body === "string" && parsed.body.trim()
      ? parsed.body.trim()
      : rawText;
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 160)
      : title;

  return {
    title,
    summary,
    body,
    tags: toStringArray(parsed.tags),
    tasks: toStringArray(parsed.tasks),
  };
}

export function processTextCapture(
  text: string,
  titleHint?: string,
  tagsHint?: readonly string[],
): ProcessedCapture {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const tasks: string[] = [];
  const bodyLines: string[] = [];

  for (const line of lines) {
    const taskMatch = line.match(/^\s*[-*]\s*\[[ xX]\]\s+(.+)$/);
    if (taskMatch) {
      tasks.push(taskMatch[1].trim());
    } else {
      bodyLines.push(line);
    }
  }

  const body = bodyLines.join("\n").trim();
  const firstMeaningfulLine =
    body
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find(Boolean) ??
    tasks[0] ??
    "Notatka tekstowa";

  const derivedTitle =
    titleHint?.trim() ||
    (firstMeaningfulLine.length > 64
      ? `${firstMeaningfulLine.slice(0, 61).trim()}...`
      : firstMeaningfulLine);

  const plainSummarySource = (body || tasks.join("; ") || derivedTitle)
    .replace(/\s+/g, " ")
    .trim();
  const summary =
    plainSummarySource.length > 160
      ? `${plainSummarySource.slice(0, 157).trim()}...`
      : plainSummarySource;

  return {
    title: derivedTitle,
    summary,
    body,
    tags: [...(tagsHint ?? [])],
    tasks,
  };
}
