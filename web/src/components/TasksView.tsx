import React, { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot } from "firebase/firestore";
import {
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ExternalLink,
  Loader2,
  Plus,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { captureWebNote, toggleTaskStatus } from "../lib/api";
import { db } from "../lib/firebase";
import type { CaptureResponse, TaskDoc, WikiIndexDoc } from "../types";

interface TasksViewProps {
  onOpenWikiSlug: (slug: string) => void;
}

type TaskStatusFilter = "open" | "due" | "done";
type TaskCategory = "all" | "obszary" | "dziennik" | "pomysly" | "projekty" | "inne";

interface TaskGroup {
  key: string;
  sourceSlug?: string;
  title: string;
  category: Exclude<TaskCategory, "all">;
  tasks: TaskDoc[];
  hasDue: boolean;
  hasOverdue: boolean;
}

const QUICK_TAGS = ["todo", "zakupy", "pomysl", "research", "dom"];

const CATEGORY_LABELS: Record<Exclude<TaskCategory, "all">, string> = {
  obszary: "Obszary",
  dziennik: "Dziennik",
  pomysly: "Pomysły",
  projekty: "Projekty",
  inne: "Inne",
};

const CATEGORY_BADGE: Record<Exclude<TaskCategory, "all">, string> = {
  obszary: "Obszar",
  dziennik: "Dziennik",
  pomysly: "Pomysł",
  projekty: "Projekt",
  inne: "Notatka",
};

const CATEGORY_ORDER: Record<Exclude<TaskCategory, "all">, number> = {
  obszary: 0,
  dziennik: 1,
  pomysly: 2,
  projekty: 3,
  inne: 4,
};

function classifyTaskCategory(task: TaskDoc): Exclude<TaskCategory, "all"> {
  const ref = (task.sourceSlug || task.sourcePath || "").toLowerCase();
  if (ref.startsWith("obszary/") || ref.includes("/wiki/obszary/")) return "obszary";
  if (ref.startsWith("dziennik/") || ref.includes("/wiki/dziennik/")) return "dziennik";
  if (ref.startsWith("pomysly/") || ref.includes("/wiki/pomysly/")) return "pomysly";
  if (ref.startsWith("projekty/") || ref.includes("/wiki/projekty/")) return "projekty";
  return "inne";
}

function humanizeSlug(raw: string): string {
  const last = raw
    .replace(/\.md$/i, "")
    .split("/")
    .filter(Boolean)
    .pop();
  if (!last) return "Notatki";
  return last
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

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
  const [slugToTitle, setSlugToTitle] = useState<Record<string, string>>({});

  // Filters & collapsed groups
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>("open");
  const [categoryFilter, setCategoryFilter] = useState<TaskCategory>("all");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  // Interactive toggle state
  const [togglingIds, setTogglingIds] = useState<Record<string, boolean>>({});
  const [optimisticCompleted, setOptimisticCompleted] = useState<Record<string, boolean>>({});
  const [toggleError, setToggleError] = useState<string | null>(null);

  // Collapsible Quick Capture
  const [captureOpen, setCaptureOpen] = useState(false);
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
        // Clear stale optimistic overrides that now match Firestore
        setOptimisticCompleted((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const task of loaded) {
            if (task.id in next && next[task.id] === task.completed) {
              delete next[task.id];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      (err) => {
        setTasksError(err.message || "Nie udało się pobrać zadań z Firestore.");
        setLoadingTasks(false);
      },
    );
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "wiki_meta", "index"), (snap) => {
      if (!snap.exists()) return;
      const data = snap.data() as WikiIndexDoc;
      const map: Record<string, string> = {};
      for (const entry of data.entries ?? []) {
        map[entry.slug] = entry.title;
      }
      setSlugToTitle(map);
    });
    return unsub;
  }, []);

  const todayIso = new Date().toISOString().slice(0, 10);

  const effectiveTasks = useMemo(
    () =>
      tasks.map((task) =>
        task.id in optimisticCompleted
          ? { ...task, completed: optimisticCompleted[task.id] }
          : task,
      ),
    [tasks, optimisticCompleted],
  );

  const statusCounts = useMemo(() => {
    const open = effectiveTasks.filter((t) => !t.completed).length;
    const due = effectiveTasks.filter((t) => !t.completed && Boolean(t.dueDate)).length;
    const done = effectiveTasks.filter((t) => t.completed).length;
    return { open, due, done };
  }, [effectiveTasks]);

  const statusMatchingTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return effectiveTasks.filter((task) => {
      if (statusFilter === "open" && task.completed) return false;
      if (statusFilter === "due" && (task.completed || !task.dueDate)) return false;
      if (statusFilter === "done" && !task.completed) return false;
      if (!q) return true;
      const topicTitle = task.sourceSlug ? slugToTitle[task.sourceSlug] ?? "" : "";
      return (
        task.text.toLowerCase().includes(q) ||
        topicTitle.toLowerCase().includes(q) ||
        (task.sourceSlug ?? "").toLowerCase().includes(q) ||
        (task.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [effectiveTasks, statusFilter, search, slugToTitle]);

  const categoryCounts = useMemo(() => {
    const counts: Record<TaskCategory, number> = {
      all: statusMatchingTasks.length,
      obszary: 0,
      dziennik: 0,
      pomysly: 0,
      projekty: 0,
      inne: 0,
    };
    for (const t of statusMatchingTasks) {
      counts[classifyTaskCategory(t)]++;
    }
    return counts;
  }, [statusMatchingTasks]);

  const categoryFilteredTasks = useMemo(() => {
    if (categoryFilter === "all") return statusMatchingTasks;
    return statusMatchingTasks.filter((t) => classifyTaskCategory(t) === categoryFilter);
  }, [statusMatchingTasks, categoryFilter]);

  const availableTags = useMemo(() => {
    const freq = new Map<string, number>();
    for (const task of categoryFilteredTasks) {
      for (const tag of task.tags ?? []) {
        freq.set(tag, (freq.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([tag, count]) => ({ tag, count }));
  }, [categoryFilteredTasks]);

  const filteredTasks = useMemo(() => {
    const list = activeTag
      ? categoryFilteredTasks.filter((t) => (t.tags ?? []).includes(activeTag))
      : categoryFilteredTasks;
    return [...list].sort(sortTasks);
  }, [categoryFilteredTasks, activeTag]);

  const groupedTasks = useMemo<TaskGroup[]>(() => {
    const map = new Map<string, TaskGroup>();
    for (const task of filteredTasks) {
      const key = task.sourceSlug || task.sourcePath || "inne";
      let group = map.get(key);
      if (!group) {
        const category = classifyTaskCategory(task);
        const title =
          (task.sourceSlug && slugToTitle[task.sourceSlug]) ||
          humanizeSlug(task.sourceSlug || task.sourcePath);
        group = {
          key,
          sourceSlug: task.sourceSlug,
          title,
          category,
          tasks: [],
          hasDue: false,
          hasOverdue: false,
        };
        map.set(key, group);
      }
      group.tasks.push(task);
      if (!task.completed && task.dueDate) {
        group.hasDue = true;
        if (task.dueDate < todayIso) group.hasOverdue = true;
      }
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.hasOverdue !== b.hasOverdue) return a.hasOverdue ? -1 : 1;
      if (a.hasDue !== b.hasDue) return a.hasDue ? -1 : 1;
      const catDiff = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
      if (catDiff !== 0) return catDiff;
      return a.title.localeCompare(b.title, "pl");
    });
  }, [filteredTasks, slugToTitle, todayIso]);

  const hasActiveFilters =
    categoryFilter !== "all" || activeTag !== null || search.trim().length > 0;

  const clearAllFilters = () => {
    setCategoryFilter("all");
    setActiveTag(null);
    setSearch("");
  };

  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleToggleTask = async (task: TaskDoc) => {
    if (togglingIds[task.id]) return;
    const nextCompleted = !task.completed;

    setToggleError(null);
    setTogglingIds((prev) => ({ ...prev, [task.id]: true }));
    setOptimisticCompleted((prev) => ({ ...prev, [task.id]: nextCompleted }));

    try {
      await toggleTaskStatus({
        sourcePath: task.sourcePath,
        text: task.text,
        completed: nextCompleted,
      });
    } catch (err) {
      setOptimisticCompleted((prev) => {
        const next = { ...prev };
        delete next[task.id];
        return next;
      });
      setToggleError(
        err instanceof Error
          ? `Nie udało się zapisać zmiany zadania: ${err.message}`
          : "Nie udało się zaktualizować zadania.",
      );
    } finally {
      setTogglingIds((prev) => {
        const next = { ...prev };
        delete next[task.id];
        return next;
      });
    }
  };

  const toggleCaptureTag = (tag: string) => {
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
      setCaptureOpen(false);
    } catch (err) {
      setCaptureError(
        err instanceof Error ? err.message : "Nie udało się wysłać notatki.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Collapsible Quick Capture */}
      <section className="rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8] shadow-[0_2px_12px_rgba(28,26,24,0.03)]">
        {!captureOpen ? (
          <button
            type="button"
            onClick={() => {
              setCaptureOpen(true);
              setCaptureSuccess(null);
            }}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-[#F7F5F0]/80 sm:px-5"
          >
            <span className="flex items-center gap-2.5 text-sm text-[#5C574F]">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-[#1C1A18] text-[#FAF9F5]">
                <Plus className="h-3.5 w-3.5" />
              </span>
              Dodaj szybką notatkę, pomysł lub zadanie...
            </span>
            <Sparkles className="h-4 w-4 shrink-0 text-[#C66A3D]" />
          </button>
        ) : (
          <div className="p-5 sm:p-6">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="font-mono-meta text-[11px] uppercase tracking-[0.16em] text-[#7A756D]">
                  Szybki zapis do skrzynki
                </p>
                <h2 className="mt-0.5 text-base font-medium text-[#1C1A18]">
                  Wyślij do Foxie Notes
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setCaptureOpen(false)}
                className="inline-flex items-center gap-1 rounded-lg border border-[#E4DFD4] bg-white px-2.5 py-1 text-xs text-[#6B655C] hover:bg-[#F2EFE8]"
              >
                <X className="h-3.5 w-3.5" />
                Zwiń
              </button>
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
                autoFocus
              />

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {QUICK_TAGS.map((tag) => {
                    const active = selectedTags.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => toggleCaptureTag(tag)}
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
          </div>
        )}

        {captureSuccess && (
          <div className="flex items-center justify-between gap-2 border-t border-[#ECE7DD] bg-[#F1F7F3] px-4 py-2.5 text-xs text-[#244B3C] sm:px-5">
            <span>
              <span className="font-medium">Zapisano:</span> {captureSuccess.title}.
              Agenci porządkują notatkę w tle.
            </span>
            <button
              type="button"
              onClick={() => setCaptureSuccess(null)}
              className="rounded p-0.5 text-[#244B3C]/70 hover:text-[#244B3C]"
              aria-label="Zamknij"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </section>

      {/* Filter Controls */}
      <section className="space-y-3">
        {/* Row 1: Status & Search */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ["open", `Otwarte (${statusCounts.open})`],
                ["due", `Z terminem (${statusCounts.due})`],
                ["done", `Ukończone (${statusCounts.done})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setStatusFilter(key)}
                className={`rounded-xl px-3.5 py-1.5 text-xs font-medium transition ${
                  statusFilter === key
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
              placeholder="Szukaj zadania lub tematu..."
              className="w-full rounded-xl border border-[#E4DFD4] bg-[#FCFBF8] py-2 pr-3 pl-9 text-xs text-[#1C1A18] placeholder-[#A8A29A] outline-none focus:border-[#9A4720]"
            />
          </div>
        </div>

        {/* Row 2: Topic Category Pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setCategoryFilter("all")}
            className={`rounded-lg px-2.5 py-1 text-xs transition ${
              categoryFilter === "all"
                ? "bg-[#EFECE3] font-medium text-[#1C1A18]"
                : "text-[#7A756D] hover:bg-[#EFECE3]/60 hover:text-[#1C1A18]"
            }`}
          >
            Wszystkie ({categoryCounts.all})
          </button>

          {(["obszary", "dziennik", "pomysly", "projekty", "inne"] as const).map(
            (cat) => {
              const count = categoryCounts[cat];
              if (cat === "inne" && count === 0) return null;
              const active = categoryFilter === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(active ? "all" : cat)}
                  className={`rounded-lg px-2.5 py-1 text-xs transition ${
                    active
                      ? "border border-[#DEC9B5] bg-[#FAF0E6] font-medium text-[#9A4720]"
                      : count === 0
                        ? "text-[#B5AEA4]"
                        : "text-[#6B655C] hover:bg-[#EFECE3]/70 hover:text-[#1C1A18]"
                  }`}
                >
                  {CATEGORY_LABELS[cat]} ({count})
                </button>
              );
            },
          )}

          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="font-mono-meta ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-[#9A4720] hover:bg-[#FAF0E6]"
            >
              <X className="h-3 w-3" />
              Wyczyść filtry
            </button>
          )}
        </div>

        {/* Row 3: Dynamic Tag Chips (only when tags exist) */}
        {availableTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono-meta text-[10px] uppercase tracking-[0.14em] text-[#9E978B]">
              Tagi:
            </span>
            {availableTags.map(({ tag, count }) => {
              const active = activeTag === tag;
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setActiveTag(active ? null : tag)}
                  className={`font-mono-meta rounded-md border px-2 py-0.5 text-[11px] transition ${
                    active
                      ? "border-[#C66A3D] bg-[#FAF0E6] text-[#9A4720]"
                      : "border-[#E4DFD4] bg-[#FCFBF8] text-[#6B655C] hover:border-[#C9C1B2]"
                  }`}
                >
                  #{tag} <span className="opacity-65">{count}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {toggleError && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-[#E6B8AF] bg-[#FDF2F0] px-4 py-2.5 text-xs text-[#8B2E24]">
          <span>{toggleError}</span>
          <button
            type="button"
            onClick={() => setToggleError(null)}
            className="rounded p-0.5 hover:bg-[#E6B8AF]/30"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Topic-Grouped Task Cards */}
      <section className="space-y-4">
        {loadingTasks ? (
          <div className="flex items-center gap-2 rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8] p-6 text-sm text-[#7A756D]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Wczytywanie zadań z Firestore...
          </div>
        ) : tasksError ? (
          <div className="rounded-2xl border border-[#E6B8AF] bg-[#FDF2F0] p-4 text-sm text-[#8B2E24]">
            {tasksError}
          </div>
        ) : groupedTasks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#D8D1C5] bg-[#FCFBF8]/60 p-8 text-center text-sm text-[#7A756D]">
            {statusFilter === "open" && statusCounts.open === 0
              ? "Brak otwartych zadań. Wszystko uporządkowane!"
              : "Brak zadań pasujących do wybranych filtrów."}
          </div>
        ) : (
          groupedTasks.map((group) => {
            const isCollapsed = Boolean(collapsedGroups[group.key]);
            return (
              <div
                key={group.key}
                className="overflow-hidden rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8] shadow-[0_2px_10px_rgba(28,26,24,0.02)]"
              >
                {/* Group Header */}
                <div className="flex items-center justify-between gap-3 border-b border-[#ECE7DD]/80 bg-[#F7F5F0]/60 px-4 py-2.5 sm:px-5">
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleGroupCollapse(group.key)}
                      className="rounded p-0.5 text-[#7A756D] transition hover:bg-[#E4DFD4]/50 hover:text-[#1C1A18]"
                      aria-label={isCollapsed ? "Rozwiń grupę" : "Zwiń grupę"}
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </button>

                    <span className="font-mono-meta shrink-0 rounded bg-[#EFECE3] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[#6B655C]">
                      {CATEGORY_BADGE[group.category]}
                    </span>

                    {group.sourceSlug ? (
                      <button
                        type="button"
                        onClick={() => onOpenWikiSlug(group.sourceSlug!)}
                        className="inline-flex min-w-0 items-center gap-1.5 truncate text-left text-sm font-medium text-[#1C1A18] transition hover:text-[#9A4720]"
                      >
                        <span className="truncate">{group.title}</span>
                        <ExternalLink className="h-3 w-3 shrink-0 opacity-50" />
                      </button>
                    ) : (
                      <span className="truncate text-sm font-medium text-[#1C1A18]">
                        {group.title}
                      </span>
                    )}
                  </div>

                  <span className="font-mono-meta shrink-0 rounded-full bg-[#EFECE3] px-2 py-0.5 text-[11px] text-[#5C574F]">
                    {group.tasks.length}
                  </span>
                </div>

                {/* Group Task Rows */}
                {!isCollapsed && (
                  <ul className="divide-y divide-[#ECE7DD]/80">
                    {group.tasks.map((task) => {
                      const isOverdue =
                        !task.completed &&
                        Boolean(task.dueDate && task.dueDate < todayIso);
                      const isToday =
                        !task.completed &&
                        Boolean(task.dueDate && task.dueDate === todayIso);
                      const isPending = Boolean(togglingIds[task.id]);
                      const hasMeta =
                        Boolean(task.dueDate) ||
                        (task.priority === "high" && !task.completed) ||
                        (task.tags && task.tags.length > 0);

                      return (
                        <li
                          key={task.id}
                          className="flex items-start gap-3 px-4 py-3 transition hover:bg-[#F7F5F0]/60 sm:px-5"
                        >
                          <button
                            type="button"
                            onClick={() => handleToggleTask(task)}
                            disabled={isPending}
                            aria-label={
                              task.completed
                                ? "Oznacz jako otwarte"
                                : "Oznacz jako ukończone"
                            }
                            className="mt-0.5 shrink-0 rounded-full p-0.5 text-[#8E887E] transition hover:text-[#2F5D50] disabled:opacity-60"
                          >
                            {isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin text-[#C66A3D]" />
                            ) : task.completed ? (
                              <CheckCircle2 className="h-4 w-4 text-[#2F5D50]" />
                            ) : (
                              <Circle className="h-4 w-4 hover:text-[#2F5D50]" />
                            )}
                          </button>

                          <div className="min-w-0 flex-1">
                            <p
                              className={`text-[15px] leading-snug ${
                                task.completed
                                  ? "text-[#8E887E] line-through"
                                  : "text-[#1C1A18]"
                              }`}
                            >
                              {task.text}
                            </p>

                            {hasMeta && (
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
                                  <button
                                    key={tag}
                                    type="button"
                                    onClick={() =>
                                      setActiveTag((prev) => (prev === tag ? null : tag))
                                    }
                                    className={`font-mono-meta rounded px-1.5 py-0.5 text-[11px] transition ${
                                      activeTag === tag
                                        ? "bg-[#FAF0E6] text-[#9A4720]"
                                        : "bg-[#EFECE3] text-[#6B655C] hover:bg-[#E4DFD4]"
                                    }`}
                                  >
                                    #{tag}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
};
