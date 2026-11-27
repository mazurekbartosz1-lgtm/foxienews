import React, { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import {
  Calendar,
  CheckCircle2,
  Circle,
  ExternalLink,
  Loader2,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { captureWebNote } from "../lib/api";
import { db } from "../lib/firebase";
import type { CaptureResponse, TaskDoc } from "../types";

interface TasksViewProps {
  onOpenWikiSlug: (slug: string) => void;
}

type TaskFilter = "open" | "due" | "all" | "done";

const QUICK_TAGS = ["todo", "zakupy", "pomysl", "research", "dom"];

function sortTasks(a: TaskDoc, b: TaskDoc): number {
  if (a.completed !== b.completed) return a.completed ? 1 : -1;
  if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) {
    return a.dueDate.localeCompare(b.dueDate);
  }
  if (a.dueDate && !b.dueDate) return -1;
  if (!a.dueDate && b.dueDate) return 1;

  const prioRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const pa = a.priority ? (prioRank[a.priority] ?? 3) : 3;
  const pb = b.priority ? (prioRank[b.priority] ?? 3) : 3;
  if (pa !== pb) return pa - pb;

  return (b.updatedAt || "").localeCompare(a.updatedAt || "");
}

export const TasksView: React.FC<TasksViewProps> = ({ onOpenWikiSlug }) => {
  const [tasks, setTasks] = useState<TaskDoc[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const [filter, setFilter] = useState<TaskFilter>("open");
  const [search, setSearch] = useState("");

  // Quick capture state
  const [noteTitle, setNoteTitle] = useState("");
  const [noteText, setNoteText] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureSuccess, setCaptureSuccess] = useState<CaptureResponse | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "tasks"),
      (snap) => {
        const loaded = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<TaskDoc, "id">),
        }));
        setTasks(loaded);
        setLoadingTasks(false);
        setTasksError(null);
      },
      (err) => {
        setTasksError(err.message || "Nie udało się pobrać zadań z Firestore.");
        setLoadingTasks(false);
      },
    );
    return unsub;
  }, []);

  const todayIso = new Date().toISOString().slice(0, 10);

  const counts = useMemo(() => {
    const open = tasks.filter((t) => !t.completed).length;
    const due = tasks.filter((t) => !t.completed && Boolean(t.dueDate)).length;
    const done = tasks.filter((t) => t.completed).length;
    return { open, due, all: tasks.length, done };
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks
      .filter((task) => {
        if (filter === "open" && task.completed) return false;
        if (filter === "due" && (task.completed || !task.dueDate)) return false;
        if (filter === "done" && !task.completed) return false;
        if (!q) return true;
        return (
          task.text.toLowerCase().includes(q) ||
          (task.sourceSlug ?? "").toLowerCase().includes(q) ||
          (task.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
        );
      })
      .sort(sortTasks);
  }, [tasks, filter, search]);

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  const handleCaptureSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!noteText.trim()) return;

    setSubmitting(true);
    setCaptureError(null);
    setCaptureSuccess(null);
    try {
      const res = await captureWebNote({
        text: noteText.trim(),
        title: noteTitle.trim() || undefined,
        tags: selectedTags,
      });
      setCaptureSuccess(res);
      setNoteText("");
      setNoteTitle("");
      setSelectedTags([]);
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : "Nie udało się wysłać notatki.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Quick Capture Card */}
      <section className="rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8] p-5 shadow-[0_4px_20px_rgba(28,26,24,0.03)] sm:p-6">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="font-mono-meta text-[11px] uppercase tracking-[0.16em] text-[#7A756D]">
              Szybka notatka / zadanie / lista
            </p>
            <h2 className="mt-1 text-lg font-medium text-[#1C1A18]">
              Wyślij do Foxie Notes
            </h2>
          </div>
          <Sparkles className="h-4 w-4 text-[#C66A3D]" />
        </div>

        <form onSubmit={handleCaptureSubmit} className="mt-4 space-y-3">
          <input
            type="text"
            value={noteTitle}
            onChange={(e) => setNoteTitle(e.target.value)}
            placeholder="Opcjonalny tytuł (np. Zakupy na weekend)"
            className="w-full rounded-xl border border-[#E4DFD4] bg-white px-3.5 py-2 text-sm text-[#1C1A18] placeholder-[#A8A29A] outline-none transition focus:border-[#9A4720]"
          />

          <textarea
            rows={3}
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Wpisz myśl, pomysł lub zadania (np. '- [ ] Kupić mleko @due(2026-12-01) #dom' albo 'W środę o 12:00 dentysta')..."
            className="w-full resize-y rounded-xl border border-[#E4DFD4] bg-white px-3.5 py-2.5 text-sm leading-relaxed text-[#1C1A18] placeholder-[#A8A29A] outline-none transition focus:border-[#9A4720]"
            required
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {QUICK_TAGS.map((tag) => {
                const active = selectedTags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    className={`font-mono-meta rounded-lg border px-2.5 py-1 text-xs transition ${
                      active
                        ? "border-[#C66A3D] bg-[#FAF0E6] text-[#9A4720]"
                        : "border-[#E4DFD4] bg-[#F7F5F0] text-[#6B655C] hover:border-[#C9C1B2]"
                    }`}
                  >
                    #{tag}
                  </button>
                );
              })}
            </div>

            <button
              type="submit"
              disabled={submitting || !noteText.trim()}
              className="inline-flex items-center gap-2 rounded-xl bg-[#1C1A18] px-4 py-2 text-sm font-medium text-[#FAF9F5] transition hover:bg-[#33302B] disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {submitting ? "Wysyłanie..." : "Zapisz do inboxu"}
            </button>
          </div>
        </form>

        {captureError && (
          <p className="mt-3 rounded-xl border border-[#E6B8AF] bg-[#FDF2F0] px-3.5 py-2 text-xs text-[#8B2E24]">
            {captureError}
          </p>
        )}

        {captureSuccess && (
          <div className="mt-3 rounded-xl border border-[#C6D8CC] bg-[#F1F7F3] px-3.5 py-2.5 text-xs text-[#244B3C]">
            <span className="font-medium">Zapisano:</span> {captureSuccess.title} (
            <code className="font-mono-meta">{captureSuccess.path}</code>). Agenci w
            tle porządkują notatkę i synchronizują zadania.
          </div>
        )}
      </section>

      {/* Tasks List Section */}
      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ["open", `Otwarte (${counts.open})`],
                ["due", `Z terminem (${counts.due})`],
                ["all", `Wszystkie (${counts.all})`],
                ["done", `Ukończone (${counts.done})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  filter === key
                    ? "bg-[#1C1A18] text-[#FAF9F5]"
                    : "border border-[#E4DFD4] bg-[#FCFBF8] text-[#5C574F] hover:bg-[#F2EFE8]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-[#9E978B]" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Szukaj w zadaniach..."
              className="w-full rounded-xl border border-[#E4DFD4] bg-[#FCFBF8] py-2 pr-3 pl-9 text-xs text-[#1C1A18] placeholder-[#A8A29A] outline-none focus:border-[#9A4720]"
            />
          </div>
        </div>

        {loadingTasks ? (
          <div className="flex items-center gap-2 rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8] p-6 text-sm text-[#7A756D]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Wczytywanie zadań z Firestore...
          </div>
        ) : tasksError ? (
          <div className="rounded-2xl border border-[#E6B8AF] bg-[#FDF2F0] p-4 text-sm text-[#8B2E24]">
            {tasksError}
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#D8D1C5] bg-[#FCFBF8]/60 p-8 text-center text-sm text-[#7A756D]">
            Brak zadań pasujących do wybranego filtra.
          </div>
        ) : (
          <ul className="divide-y divide-[#ECE7DD] overflow-hidden rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8]">
            {filteredTasks.map((task) => {
              const isOverdue =
                !task.completed && Boolean(task.dueDate && task.dueDate < todayIso);
              const isToday =
                !task.completed && Boolean(task.dueDate && task.dueDate === todayIso);

              return (
                <li
                  key={task.id}
                  className="flex items-start justify-between gap-4 px-4 py-3.5 transition hover:bg-[#F7F5F0]/70 sm:px-5"
                >
                  <div className="flex items-start gap-3">
                    {task.completed ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#2F5D50]" />
                    ) : (
                      <Circle className="mt-0.5 h-4 w-4 shrink-0 text-[#9E978B]" />
                    )}

                    <div>
                      <p
                        className={`text-[15px] leading-snug ${
                          task.completed
                            ? "text-[#8E887E] line-through"
                            : "text-[#1C1A18]"
                        }`}
                      >
                        {task.text}
                      </p>

                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        {task.dueDate && (
                          <span
                            className={`font-mono-meta inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
                              isOverdue
                                ? "border-[#E6B8AF] bg-[#FDF2F0] text-[#8B2E24]"
                                : isToday
                                  ? "border-[#DEC9B5] bg-[#FAF0E6] text-[#9A4720]"
                                  : "border-[#E4DFD4] bg-[#F2EFE8] text-[#5C574F]"
                            }`}
                          >
                            <Calendar className="h-3 w-3" />
                            {task.dueDate}
                          </span>
                        )}

                        {task.priority === "high" && !task.completed && (
                          <span className="font-mono-meta rounded border border-[#E6B8AF] bg-[#FDF2F0] px-1.5 py-0.5 text-[10px] uppercase text-[#8B2E24]">
                            priorytet
                          </span>
                        )}

                        {(task.tags ?? []).map((tag) => (
                          <span
                            key={tag}
                            className="font-mono-meta rounded bg-[#EFECE3] px-1.5 py-0.5 text-[11px] text-[#6B655C]"
                          >
                            #{tag}
                          </span>
                        ))}

                        {task.sourceSlug && (
                          <button
                            type="button"
                            onClick={() => onOpenWikiSlug(task.sourceSlug!)}
                            className="font-mono-meta inline-flex items-center gap-1 text-[11px] text-[#9A4720] hover:underline"
                          >
                            [[{task.sourceSlug}]]
                            <ExternalLink className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};
