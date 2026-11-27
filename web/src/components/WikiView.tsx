import React, { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import {
  ArrowLeft,
  BookOpen,
  CalendarPlus,
  FlaskConical,
  Loader2,
  Search,
} from "lucide-react";
import { triggerPlanForPage, triggerResearchForPage } from "../lib/api";
import { db, slugToDocId } from "../lib/firebase";
import { MarkdownContent } from "../lib/markdown";
import type { WikiIndexDoc, WikiIndexEntry, WikiPageDoc } from "../types";

interface WikiViewProps {
  selectedSlug: string;
  onSelectSlug: (slug: string) => void;
}

type ParaGroup =
  | "Projekty"
  | "Obszary"
  | "Pomysły"
  | "Zasoby"
  | "Dziennik"
  | "System";

const GROUP_ORDER: ParaGroup[] = [
  "Obszary",
  "Pomysły",
  "Dziennik",
  "Projekty",
  "Zasoby",
  "System",
];

function classifyGroup(slug: string): ParaGroup {
  if (slug.startsWith("projekty/")) return "Projekty";
  if (slug.startsWith("obszary/")) return "Obszary";
  if (slug.startsWith("pomysly/")) return "Pomysły";
  if (slug.startsWith("zasoby/")) return "Zasoby";
  if (slug.startsWith("dziennik/")) return "Dziennik";
  return "System";
}

export const WikiView: React.FC<WikiViewProps> = ({
  selectedSlug,
  onSelectSlug,
}) => {
  const [indexDoc, setIndexDoc] = useState<WikiIndexDoc | null>(null);
  const [loadingIndex, setLoadingIndex] = useState(true);
  const [search, setSearch] = useState("");

  const [pageDoc, setPageDoc] = useState<WikiPageDoc | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [mobileShowReader, setMobileShowReader] = useState(Boolean(selectedSlug));

  const [actionBusy, setActionBusy] = useState<"research" | "plan" | null>(null);
  const [actionMessage, setActionMessage] = useState<{
    text: string;
    prUrl?: string;
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

  const activeSlug = useMemo(() => {
    if (selectedSlug) return selectedSlug;
    const firstNonLog = indexDoc?.entries.find((e) => e.slug !== "log");
    return firstNonLog?.slug ?? indexDoc?.entries[0]?.slug ?? "";
  }, [selectedSlug, indexDoc]);

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

  const groupedEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = (indexDoc?.entries ?? []).filter((entry) => {
      if (!q) return true;
      return (
        entry.title.toLowerCase().includes(q) ||
        entry.slug.toLowerCase().includes(q) ||
        entry.summary.toLowerCase().includes(q) ||
        entry.tags.some((t) => t.toLowerCase().includes(q))
      );
    });

    const map = new Map<ParaGroup, WikiIndexEntry[]>();
    for (const g of GROUP_ORDER) map.set(g, []);
    for (const entry of filtered) {
      map.get(classifyGroup(entry.slug))?.push(entry);
    }
    return map;
  }, [indexDoc, search]);

  const handleRunResearch = async () => {
    if (!pageDoc?.path) return;
    setActionBusy("research");
    setActionMessage(null);
    try {
      const res = await triggerResearchForPage(pageDoc.path);
      setActionMessage({
        text:
          res.status === "created"
            ? `Otwarto Pull Request #${res.prNumber} w obsydianandwiki.`
            : `Otwarty PR już istnieje (#${res.prNumber}).`,
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

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Left Sidebar: Wiki Index */}
      <aside
        className={`space-y-4 lg:col-span-4 ${
          mobileShowReader ? "hidden lg:block" : "block"
        }`}
      >
        <div className="rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8] p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-[#9E978B]" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Szukaj w Wiki (tytuł, #tag)..."
              className="w-full rounded-xl border border-[#E4DFD4] bg-white py-2 pr-3 pl-9 text-xs text-[#1C1A18] placeholder-[#A8A29A] outline-none focus:border-[#9A4720]"
            />
          </div>

          {loadingIndex ? (
            <div className="mt-4 flex items-center gap-2 text-xs text-[#7A756D]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Ładowanie spisu treści...
            </div>
          ) : (
            <div className="mt-4 max-h-[68vh] space-y-5 overflow-y-auto pr-1">
              {GROUP_ORDER.map((group) => {
                const items = groupedEntries.get(group) ?? [];
                if (items.length === 0) return null;
                return (
                  <div key={group}>
                    <h3 className="font-mono-meta mb-1.5 px-2 text-[10px] font-medium uppercase tracking-[0.16em] text-[#8E887E]">
                      {group} ({items.length})
                    </h3>
                    <ul className="space-y-1">
                      {items.map((entry) => {
                        const isSelected = entry.slug === activeSlug;
                        return (
                          <li key={entry.slug}>
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
                              <p
                                className={`font-mono-meta mt-0.5 truncate text-[10px] ${
                                  isSelected ? "text-[#D4CEC2]" : "text-[#8E887E]"
                                }`}
                              >
                                {entry.slug}
                              </p>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {/* Right Pane: Wiki Article Reader */}
      <section
        className={`lg:col-span-8 ${
          mobileShowReader ? "block" : "hidden lg:block"
        }`}
      >
        <div className="rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8] p-5 shadow-[0_4px_20px_rgba(28,26,24,0.03)] sm:p-8">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-2 border-b border-[#ECE7DD] pb-4">
            <div className="flex items-center gap-2">
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
              <span className="font-mono-meta text-[11px] text-[#8E887E]">
                {activeSlug || "wiki"}
              </span>
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
                  Research PR
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
            <article>
              <div className="mb-5 flex flex-wrap items-center gap-2">
                {pageDoc.tags.map((tag) => (
                  <span
                    key={tag}
                    className="font-mono-meta rounded bg-[#EFECE3] px-2 py-0.5 text-[11px] text-[#6B655C]"
                  >
                    #{tag}
                  </span>
                ))}
                {pageDoc.updatedAt && (
                  <span className="font-mono-meta ml-auto text-[11px] text-[#8E887E]">
                    Aktualizacja: {pageDoc.updatedAt.slice(0, 16).replace("T", " ")} UTC
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
