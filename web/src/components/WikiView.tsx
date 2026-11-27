import React, { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import {
  ArrowLeft,
  BookOpen,
  CalendarPlus,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FlaskConical,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { triggerPlanForPage, triggerResearchForPage } from "../lib/api";
import { db, normalizeSlug, slugToDocId } from "../lib/firebase";
import { MarkdownContent } from "../lib/markdown";
import type { WikiIndexDoc, WikiIndexEntry, WikiPageDoc } from "../types";

interface WikiViewProps {
  selectedSlug: string;
  onSelectSlug: (slug: string) => void;
}

type ParaGroup =
  | "Obszary"
  | "Pomysły"
  | "Dziennik"
  | "Projekty"
  | "Zasoby"
  | "System";

type CategoryFilter = "all" | Exclude<ParaGroup, "System">;

interface NestedWikiItem {
  entry: WikiIndexEntry;
  researchChild?: WikiIndexEntry;
}

const CONTENT_GROUPS: Exclude<ParaGroup, "System">[] = [
  "Obszary",
  "Pomysły",
  "Dziennik",
  "Projekty",
  "Zasoby",
];

function classifyGroup(slug: string): ParaGroup {
  if (slug.startsWith("obszary/")) return "Obszary";
  if (slug.startsWith("pomysly/")) return "Pomysły";
  if (slug.startsWith("dziennik/")) return "Dziennik";
  if (slug.startsWith("projekty/")) return "Projekty";
  if (slug.startsWith("zasoby/")) return "Zasoby";
  return "System";
}

function formatBreadcrumb(slug: string): string {
  if (!slug) return "Wiki";
  const parts = slug.split("/").filter(Boolean);
  const group = classifyGroup(slug);
  if (parts.length <= 1) return group;
  const tail = parts.slice(1).map((seg) =>
    seg === "research"
      ? "Research"
      : seg.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  );
  return [group, ...tail].join(" › ");
}

export const WikiView: React.FC<WikiViewProps> = ({
  selectedSlug,
  onSelectSlug,
}) => {
  const [indexDoc, setIndexDoc] = useState<WikiIndexDoc | null>(null);
  const [loadingIndex, setLoadingIndex] = useState(true);

  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({
    Projekty: true,
    Zasoby: true,
  });

  const [pageDoc, setPageDoc] = useState<WikiPageDoc | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [mobileShowReader, setMobileShowReader] = useState(Boolean(selectedSlug));

  const [actionBusy, setActionBusy] = useState<"research" | "plan" | null>(null);
  const [actionMessage, setActionMessage] = useState<{
    text: string;
    prUrl?: string;
    openSlug?: string;
    isError?: boolean;
  } | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, "wiki_meta", "index"),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as WikiIndexDoc;
          setIndexDoc(data);
        } else {
          setIndexDoc({ entries: [], updatedAt: "" });
        }
        setLoadingIndex(false);
      },
      () => {
        setLoadingIndex(false);
      },
    );
    return unsub;
  }, []);

  const allEntries = indexDoc?.entries ?? [];
  const logEntry = useMemo(
    () => allEntries.find((e) => e.slug === "log") ?? null,
    [allEntries],
  );
  const contentEntries = useMemo(
    () => allEntries.filter((e) => classifyGroup(e.slug) !== "System"),
    [allEntries],
  );
  const slugSet = useMemo(
    () => new Set(allEntries.map((e) => e.slug)),
    [allEntries],
  );

  const activeSlug = useMemo(() => {
    if (selectedSlug) return selectedSlug;
    const preferred =
      contentEntries.find((e) => e.slug.startsWith("obszary/")) ??
      contentEntries.find((e) => e.slug.startsWith("pomysly/")) ??
      contentEntries[0];
    return preferred?.slug ?? logEntry?.slug ?? "";
  }, [selectedSlug, contentEntries, logEntry]);

  // Auto-expand the group containing the currently active page
  useEffect(() => {
    if (!activeSlug) return;
    const grp = classifyGroup(activeSlug);
    if (grp !== "System") {
      setCollapsedGroups((prev) => (prev[grp] ? { ...prev, [grp]: false } : prev));
    }
  }, [activeSlug]);

  useEffect(() => {
    if (!activeSlug) {
      setPageDoc(null);
      return;
    }

    setLoadingPage(true);
    setActionMessage(null);
    const docId = slugToDocId(activeSlug);
    const unsub = onSnapshot(
      doc(db, "wiki_pages", docId),
      (snap) => {
        setPageDoc(snap.exists() ? (snap.data() as WikiPageDoc) : null);
        setLoadingPage(false);
      },
      () => {
        setPageDoc(null);
        setLoadingPage(false);
      },
    );
    return unsub;
  }, [activeSlug]);

  const navigateToSlug = (nextSlug: string) => {
    if (!nextSlug || nextSlug === activeSlug) {
      setMobileShowReader(true);
      return;
    }
    if (activeSlug) {
      setHistory((prev) => [...prev.slice(-14), activeSlug]);
    }
    onSelectSlug(nextSlug);
    setMobileShowReader(true);
  };

  const handleBack = () => {
    if (history.length > 0) {
      const prevSlug = history[history.length - 1];
      setHistory((prev) => prev.slice(0, -1));
      onSelectSlug(prevSlug);
      return;
    }
    setMobileShowReader(false);
  };

  // Counts per PARA category (excluding nested */research duplicates so counts match topics)
  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      all: 0,
      Obszary: 0,
      Pomysły: 0,
      Dziennik: 0,
      Projekty: 0,
      Zasoby: 0,
    };
    for (const entry of contentEntries) {
      const grp = classifyGroup(entry.slug);
      if (grp === "System") continue;
      if (
        entry.slug.endsWith("/research") &&
        slugSet.has(entry.slug.replace(/\/research$/, ""))
      ) {
        continue;
      }
      counts[grp]++;
      counts.all++;
    }
    return counts;
  }, [contentEntries, slugSet]);

  // Dynamic tags for current category filter
  const availableTags = useMemo(() => {
    const freq = new Map<string, number>();
    for (const entry of contentEntries) {
      if (
        categoryFilter !== "all" &&
        classifyGroup(entry.slug) !== categoryFilter
      ) {
        continue;
      }
      for (const tag of entry.tags) {
        if (tag === "research" || tag === "log") continue;
        freq.set(tag, (freq.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([tag]) => tag);
  }, [contentEntries, categoryFilter]);

  // Build grouped + nested sidebar structure
  const groupedItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matchesFilters = (entry: WikiIndexEntry) => {
      if (
        categoryFilter !== "all" &&
        classifyGroup(entry.slug) !== categoryFilter
      ) {
        return false;
      }
      if (activeTag && !entry.tags.includes(activeTag)) {
        return false;
      }
      if (!q) return true;
      return (
        entry.title.toLowerCase().includes(q) ||
        entry.slug.toLowerCase().includes(q) ||
        entry.summary.toLowerCase().includes(q) ||
        entry.tags.some((t) => t.toLowerCase().includes(q))
      );
    };

    const researchByParent = new Map<string, WikiIndexEntry>();
    const standaloneEntries: WikiIndexEntry[] = [];

    for (const entry of contentEntries) {
      if (entry.slug.endsWith("/research")) {
        const parentSlug = entry.slug.replace(/\/research$/, "");
        if (slugSet.has(parentSlug)) {
          researchByParent.set(parentSlug, entry);
          continue;
        }
      }
      standaloneEntries.push(entry);
    }

    const map = new Map<Exclude<ParaGroup, "System">, NestedWikiItem[]>();
    for (const g of CONTENT_GROUPS) map.set(g, []);

    for (const entry of standaloneEntries) {
      const grp = classifyGroup(entry.slug);
      if (grp === "System") continue;
      const child = researchByParent.get(entry.slug);
      const parentMatch = matchesFilters(entry);
      const childMatch = child ? matchesFilters(child) : false;

      if (!parentMatch && !childMatch) continue;
      map.get(grp)?.push({ entry, researchChild: child });
    }

    // Dziennik newest first
    map.get("Dziennik")?.sort((a, b) => b.entry.slug.localeCompare(a.entry.slug));

    return map;
  }, [contentEntries, slugSet, categoryFilter, activeTag, search]);

  const forceExpanded =
    categoryFilter !== "all" || activeTag !== null || search.trim().length > 0;

  // Contextual parent / child link in Reader header
  const siblingLink = useMemo<{ slug: string; label: string } | null>(() => {
    if (!activeSlug) return null;
    if (activeSlug.endsWith("/research")) {
      const parentSlug = activeSlug.replace(/\/research$/, "");
      if (slugSet.has(parentSlug)) {
        return { slug: parentSlug, label: "← Wróć do notatki głównej" };
      }
    } else {
      const researchSlug = `${activeSlug}/research`;
      if (slugSet.has(researchSlug)) {
        return { slug: researchSlug, label: "Otwórz raport Research →" };
      }
    }
    return null;
  }, [activeSlug, slugSet]);

  const handleRunResearch = async () => {
    if (!pageDoc?.path) return;
    setActionBusy("research");
    setActionMessage(null);
    try {
      const res = await triggerResearchForPage(pageDoc.path, true);
      const reportSlug = res.reportPath
        ? normalizeSlug(res.reportPath.replace(/^wiki\//i, ""))
        : undefined;
      setActionMessage({
        text:
          res.status === "created"
            ? "Zapisano raport Research bezpośrednio w Wiki."
            : "Raport Research już istnieje w Wiki.",
        openSlug: reportSlug,
        prUrl: res.prUrl,
      });
    } catch (err) {
      setActionMessage({
        text: err instanceof Error ? err.message : "Błąd uruchamiania Researchera.",
        isError: true,
      });
    } finally {
      setActionBusy(null);
    }
  };

  const handleRunPlan = async () => {
    if (!pageDoc?.path) return;
    setActionBusy("plan");
    setActionMessage(null);
    try {
      const res = await triggerPlanForPage(pageDoc.path);
      if (res.status === "skipped") {
        setActionMessage({
          text: `Pominięto synchronizację (${res.reason ?? "brak konfiguracji"}).`,
        });
      } else {
        setActionMessage({
          text: `Google Sync OK: ${res.calendarEventsCreated.length} wydarzeń, ${res.tasksCreated.length} zadań, ${res.listItemsCreated.length} pozycji na listach.`,
        });
      }
    } catch (err) {
      setActionMessage({
        text: err instanceof Error ? err.message : "Błąd synchronizacji z Google.",
        isError: true,
      });
    } finally {
      setActionBusy(null);
    }
  };

  const toggleGroupCollapse = (group: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [group]: !prev[group] }));
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Left Sidebar: Organized Wiki Navigation */}
      <aside
        className={`space-y-4 lg:col-span-4 ${
          mobileShowReader ? "hidden lg:block" : "block"
        }`}
      >
        <div className="rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8] p-4 shadow-[0_2px_12px_rgba(28,26,24,0.02)]">
          {/* Search */}
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-[#9E978B]" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Szukaj w Wiki..."
              className="w-full rounded-xl border border-[#E4DFD4] bg-white py-2 pr-3 pl-9 text-xs text-[#1C1A18] placeholder-[#A8A29A] outline-none focus:border-[#9A4720]"
            />
          </div>

          {/* Category Filter Pills */}
          <div className="mt-3 flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setCategoryFilter("all");
                setActiveTag(null);
              }}
              className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition ${
                categoryFilter === "all"
                  ? "bg-[#1C1A18] text-[#FAF9F5]"
                  : "text-[#6B655C] hover:bg-[#EFECE3]"
              }`}
            >
              Wszystkie ({categoryCounts.all})
            </button>
            {CONTENT_GROUPS.map((grp) => {
              const count = categoryCounts[grp];
              const active = categoryFilter === grp;
              return (
                <button
                  key={grp}
                  type="button"
                  onClick={() => setCategoryFilter(active ? "all" : grp)}
                  className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition ${
                    active
                      ? "bg-[#1C1A18] text-[#FAF9F5]"
                      : count === 0
                        ? "text-[#B8B1A5]"
                        : "text-[#6B655C] hover:bg-[#EFECE3]"
                  }`}
                >
                  {grp} ({count})
                </button>
              );
            })}
          </div>

          {/* Dynamic Tag Filter Strip */}
          {availableTags.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1 border-t border-[#ECE7DD]/70 pt-2.5">
              {availableTags.map((tag) => {
                const active = activeTag === tag;
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setActiveTag(active ? null : tag)}
                    className={`font-mono-meta rounded-md border px-1.5 py-0.5 text-[10px] transition ${
                      active
                        ? "border-[#C66A3D] bg-[#FAF0E6] text-[#9A4720]"
                        : "border-[#E4DFD4] bg-white text-[#6B655C] hover:border-[#C9C1B2]"
                    }`}
                  >
                    #{tag}
                  </button>
                );
              })}
              {activeTag && (
                <button
                  type="button"
                  onClick={() => setActiveTag(null)}
                  className="font-mono-meta inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-[#9A4720] hover:underline"
                >
                  <X className="h-2.5 w-2.5" />
                  Wyczyść
                </button>
              )}
            </div>
          )}

          {/* Grouped Tree List */}
          {loadingIndex ? (
            <div className="mt-4 flex items-center gap-2 text-xs text-[#7A756D]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Ładowanie spisu treści...
            </div>
          ) : (
            <div className="mt-3 max-h-[62vh] space-y-3 overflow-y-auto pr-1">
              {CONTENT_GROUPS.map((group) => {
                const items = groupedItems.get(group) ?? [];
                if (items.length === 0) return null;
                const isCollapsed = !forceExpanded && Boolean(collapsedGroups[group]);

                return (
                  <div key={group} className="border-t border-[#ECE7DD]/70 pt-2.5 first:border-t-0 first:pt-0">
                    <button
                      type="button"
                      onClick={() => toggleGroupCollapse(group)}
                      className="flex w-full items-center justify-between px-1.5 py-1 text-left"
                    >
                      <span className="font-mono-meta flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-[#7A756D]">
                        {isCollapsed ? (
                          <ChevronRight className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        )}
                        {group}
                      </span>
                      <span className="font-mono-meta text-[10px] text-[#9E978B]">
                        {items.length}
                      </span>
                    </button>

                    {!isCollapsed && (
                      <ul className="mt-1 space-y-1">
                        {items.map(({ entry, researchChild }) => {
                          const isSelected = entry.slug === activeSlug;
                          const isChildSelected = researchChild?.slug === activeSlug;

                          return (
                            <li key={entry.slug} className="space-y-1">
                              <button
                                type="button"
                                onClick={() => navigateToSlug(entry.slug)}
                                className={`w-full rounded-xl px-2.5 py-2 text-left transition ${
                                  isSelected
                                    ? "bg-[#1C1A18] text-[#FAF9F5]"
                                    : "text-[#2A2622] hover:bg-[#F2EFE8]"
                                }`}
                              >
                                <p className="text-sm font-medium leading-snug">
                                  {entry.title}
                                </p>
                                {entry.summary && entry.summary !== entry.title && (
                                  <p
                                    className={`mt-0.5 line-clamp-1 text-[11px] ${
                                      isSelected ? "text-[#D4CEC2]" : "text-[#8E887E]"
                                    }`}
                                  >
                                    {entry.summary}
                                  </p>
                                )}
                              </button>

                              {researchChild && (
                                <button
                                  type="button"
                                  onClick={() => navigateToSlug(researchChild.slug)}
                                  className={`ml-3 flex w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition ${
                                    isChildSelected
                                      ? "bg-[#FAF0E6] font-medium text-[#9A4720] ring-1 ring-[#DEC9B5]"
                                      : "text-[#6B655C] hover:bg-[#F2EFE8] hover:text-[#1C1A18]"
                                  }`}
                                >
                                  <CornerDownRight className="h-3 w-3 shrink-0 text-[#C66A3D]" />
                                  <span className="truncate">Raport Research</span>
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}

              {/* Empty search state */}
              {CONTENT_GROUPS.every(
                (g) => (groupedItems.get(g)?.length ?? 0) === 0,
              ) && (
                <p className="py-6 text-center text-xs text-[#8E887E]">
                  Brak stron pasujących do wybranych filtrów.
                </p>
              )}
            </div>
          )}

          {/* Subtle System Log Footer Link */}
          {logEntry && (
            <div className="mt-3 border-t border-[#ECE7DD] pt-2.5">
              <button
                type="button"
                onClick={() => navigateToSlug(logEntry.slug)}
                className={`font-mono-meta flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[11px] transition ${
                  activeSlug === logEntry.slug
                    ? "bg-[#1C1A18] text-[#FAF9F5]"
                    : "text-[#8E887E] hover:bg-[#F2EFE8] hover:text-[#1C1A18]"
                }`}
              >
                <span>Log zmian agentów</span>
                <span>→</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Right Pane: Calmer Article Reader */}
      <section
        className={`lg:col-span-8 ${
          mobileShowReader ? "block" : "hidden lg:block"
        }`}
      >
        <div className="rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8] p-5 shadow-[0_4px_20px_rgba(28,26,24,0.03)] sm:p-8">
          {/* Reader Header Bar */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-2 border-b border-[#ECE7DD] pb-4">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleBack}
                className={`inline-flex items-center gap-1.5 rounded-lg border border-[#E4DFD4] bg-white px-2.5 py-1 text-xs text-[#5C574F] hover:bg-[#F2EFE8] ${
                  history.length === 0 ? "lg:hidden" : ""
                }`}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {history.length > 0 ? "Wróć" : "Spis treści"}
              </button>

              <span className="font-mono-meta text-[11px] text-[#7A756D]">
                {formatBreadcrumb(activeSlug)}
              </span>

              {siblingLink && (
                <button
                  type="button"
                  onClick={() => navigateToSlug(siblingLink.slug)}
                  className="rounded-lg border border-[#DEC9B5] bg-[#FAF0E6] px-2.5 py-0.5 text-[11px] font-medium text-[#9A4720] transition hover:bg-[#F3E2D1]"
                >
                  {siblingLink.label}
                </button>
              )}
            </div>

            {pageDoc && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleRunResearch}
                  disabled={actionBusy !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#E4DFD4] bg-white px-2.5 py-1.5 text-xs font-medium text-[#1C1A18] transition hover:bg-[#F2EFE8] disabled:opacity-50"
                >
                  {actionBusy === "research" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FlaskConical className="h-3.5 w-3.5 text-[#C66A3D]" />
                  )}
                  Zrób Research
                </button>

                <button
                  type="button"
                  onClick={handleRunPlan}
                  disabled={actionBusy !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#E4DFD4] bg-white px-2.5 py-1.5 text-xs font-medium text-[#1C1A18] transition hover:bg-[#F2EFE8] disabled:opacity-50"
                >
                  {actionBusy === "plan" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CalendarPlus className="h-3.5 w-3.5 text-[#2F5D50]" />
                  )}
                  Wyślij do Google
                </button>
              </div>
            )}
          </div>

          {actionMessage && (
            <div
              className={`mb-5 rounded-xl border px-3.5 py-2.5 text-xs ${
                actionMessage.isError
                  ? "border-[#E6B8AF] bg-[#FDF2F0] text-[#8B2E24]"
                  : "border-[#C6D8CC] bg-[#F1F7F3] text-[#244B3C]"
              }`}
            >
              <span>{actionMessage.text}</span>
              {actionMessage.openSlug && (
                <button
                  type="button"
                  onClick={() => navigateToSlug(actionMessage.openSlug!)}
                  className="font-mono-meta ml-2 font-medium underline"
                >
                  Otwórz raport →
                </button>
              )}
              {actionMessage.prUrl && (
                <a
                  href={actionMessage.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-2 font-medium underline"
                >
                  Otwórz PR na GitHubie
                </a>
              )}
            </div>
          )}

          {loadingPage ? (
            <div className="flex items-center gap-2 py-8 text-sm text-[#7A756D]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Wczytywanie strony Wiki...
            </div>
          ) : !pageDoc ? (
            <div className="py-10 text-center text-sm text-[#7A756D]">
              <BookOpen className="mx-auto mb-2 h-6 w-6 text-[#A8A29A]" />
              {activeSlug
                ? `Strona "${activeSlug}" nie została jeszcze zsynchronizowana z GitHuba.`
                : "Wybierz stronę ze spisu treści."}
            </div>
          ) : (
            <article className="max-w-3xl">
              <div className="mb-5 flex flex-wrap items-center gap-1.5">
                {pageDoc.tags.map((tag) => {
                  const selected = activeTag === tag;
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() =>
                        setActiveTag((prev) => (prev === tag ? null : tag))
                      }
                      className={`font-mono-meta rounded px-2 py-0.5 text-[11px] transition ${
                        selected
                          ? "bg-[#FAF0E6] text-[#9A4720] ring-1 ring-[#DEC9B5]"
                          : "bg-[#EFECE3] text-[#6B655C] hover:bg-[#E4DFD4]"
                      }`}
                    >
                      #{tag}
                    </button>
                  );
                })}
                {pageDoc.updatedAt && (
                  <span className="font-mono-meta ml-auto text-[11px] text-[#8E887E]">
                    Aktualizacja: {pageDoc.updatedAt.slice(0, 10)}
                  </span>
                )}
              </div>

              <MarkdownContent
                markdown={pageDoc.markdown}
                onNavigateSlug={navigateToSlug}
              />
            </article>
          )}
        </div>
      </section>
    </div>
  );
};
