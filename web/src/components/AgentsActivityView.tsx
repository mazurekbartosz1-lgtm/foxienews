import React, { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import {
  Bot,
  CalendarCheck2,
  CheckCircle2,
  Clock,
  ExternalLink,
  GitPullRequest,
  Loader2,
  Play,
  XCircle,
} from "lucide-react";
import { triggerOrganizeInbox } from "../lib/api";
import { db, normalizeSlug } from "../lib/firebase";
import type { InboxJobDoc } from "../types";

interface AgentsActivityViewProps {
  onOpenWikiSlug: (slug: string) => void;
}

export const AgentsActivityView: React.FC<AgentsActivityViewProps> = ({
  onOpenWikiSlug,
}) => {
  const [jobs, setJobs] = useState<InboxJobDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningBatch, setRunningBatch] = useState(false);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "inbox_jobs"),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<InboxJobDoc, "id">) }))
          .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
        setJobs(list);
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  const handleRunBatch = async () => {
    setRunningBatch(true);
    setBatchMessage(null);
    try {
      const res = await triggerOrganizeInbox(10);
      setBatchMessage(
        `Przetworzono: ${res.processed}, pominięto: ${res.skipped}, błędy: ${res.errors}.`,
      );
    } catch (err) {
      setBatchMessage(
        err instanceof Error ? err.message : "Nie udało się uruchomić Organizatora.",
      );
    } finally {
      setRunningBatch(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8] p-5 sm:flex-row sm:items-center">
        <div>
          <p className="font-mono-meta text-[11px] uppercase tracking-[0.16em] text-[#7A756D]">
            Chmurowi agenci · Organizator · Researcher PR · Planowanie
          </p>
          <h2 className="mt-1 text-lg font-medium text-[#1C1A18]">
            Dziennik przetwarzania `raw/inbox/`
          </h2>
        </div>

        <button
          type="button"
          onClick={handleRunBatch}
          disabled={runningBatch}
          className="inline-flex items-center gap-2 rounded-xl bg-[#1C1A18] px-4 py-2 text-xs font-medium text-[#FAF9F5] transition hover:bg-[#33302B] disabled:opacity-50"
        >
          {runningBatch ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Przetwórz zaległy inbox
        </button>
      </div>

      {batchMessage && (
        <div className="rounded-xl border border-[#DED8CB] bg-[#F2EFE8] px-4 py-2.5 text-xs text-[#2A2622]">
          {batchMessage}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8] p-6 text-sm text-[#7A756D]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Wczytywanie historii agentów...
        </div>
      ) : jobs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[#D8D1C5] bg-[#FCFBF8]/60 p-8 text-center text-sm text-[#7A756D]">
          <Bot className="mx-auto mb-2 h-6 w-6 text-[#A8A29A]" />
          Brak zarejestrowanych uruchomień w kolekcji <code className="font-mono-meta">inbox_jobs</code>.
        </div>
      ) : (
        <ul className="space-y-3">
          {jobs.map((job) => {
            const targetSlug = job.targetPath
              ? normalizeSlug(job.targetPath.replace(/^wiki\//i, ""))
              : undefined;

            return (
              <li
                key={job.id}
                className="rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8] p-4 sm:p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {job.status === "done" ? (
                      <CheckCircle2 className="h-4 w-4 text-[#2F5D50]" />
                    ) : job.status === "error" ? (
                      <XCircle className="h-4 w-4 text-[#8B2E24]" />
                    ) : (
                      <Clock className="h-4 w-4 text-[#9A4720]" />
                    )}
                    <span className="font-mono-meta text-xs font-medium text-[#1C1A18]">
                      {job.inboxPath.replace(/^raw\/inbox\//, "")}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {job.intent && (
                      <span className="font-mono-meta rounded bg-[#EFECE3] px-2 py-0.5 text-[11px] text-[#5C574F]">
                        {job.intent}
                      </span>
                    )}
                    <span className="font-mono-meta text-[11px] text-[#8E887E]">
                      {job.updatedAt?.slice(0, 16).replace("T", " ")} UTC
                    </span>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                  {targetSlug && (
                    <button
                      type="button"
                      onClick={() => onOpenWikiSlug(targetSlug)}
                      className="font-mono-meta inline-flex items-center gap-1 text-[#9A4720] hover:underline"
                    >
                      [[{targetSlug}]]
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  )}

                  {job.researchPrUrl && (
                    <a
                      href={job.researchPrUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg border border-[#C6D8CC] bg-[#F1F7F3] px-2.5 py-1 font-medium text-[#244B3C] hover:bg-[#E4EFE7]"
                    >
                      <GitPullRequest className="h-3.5 w-3.5" />
                      Research PR #{job.researchPrNumber}
                    </a>
                  )}

                  {job.planningStatus === "synced" && (
                    <span className="inline-flex items-center gap-1 rounded-lg border border-[#DEC9B5] bg-[#FAF0E6] px-2.5 py-1 text-[#9A4720]">
                      <CalendarCheck2 className="h-3.5 w-3.5" />
                      Google: {(job.googleEventIds?.length ?? 0)} wyd. /{" "}
                      {(job.googleTaskIds?.length ?? 0)} zadań
                    </span>
                  )}
                </div>

                {job.error && (
                  <p className="mt-2 rounded-lg bg-[#FDF2F0] px-3 py-1.5 text-xs text-[#8B2E24]">
                    {job.error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
