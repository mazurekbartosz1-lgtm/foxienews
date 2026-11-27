import React, { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import {
  Bot,
  CalendarCheck2,
  CheckCircle2,
  Clock,
  ExternalLink,
  FolderTree,
  GitPullRequest,
  Loader2,
  Play,
  XCircle,
} from "lucide-react";
import { triggerOrganizeInbox, triggerVaultCommand } from "../lib/api";
import { db, normalizeSlug } from "../lib/firebase";
import type { InboxJobDoc, VaultCommandRunResponse } from "../types";

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
  const [commandText, setCommandText] = useState("");
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandResult, setCommandResult] = useState<VaultCommandRunResponse | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);

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

  const handleRunCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = commandText.trim();
    if (!trimmed) return;
    setCommandBusy(true);
    setCommandError(null);
    setCommandResult(null);
    try {
      const res = await triggerVaultCommand(trimmed);
      setCommandResult(res);
      if (res.status === "executed") {
        setCommandText("");
      }
    } catch (err) {
      setCommandError(
        err instanceof Error ? err.message : "Nie udało się uruchomić Kuratora Wiki.",
      );
    } finally {
      setCommandBusy(false);
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

      <form
        onSubmit={handleRunCommand}
        className="rounded-2xl border border-[#E4DFD4] bg-[#FCFBF8] p-5"
      >
        <div className="flex items-center gap-2 text-[#1C1A18]">
          <FolderTree className="h-4 w-4 text-[#9A4720]" />
          <p className="font-mono-meta text-[11px] uppercase tracking-[0.16em] text-[#7A756D]">
            Kurator Wiki · Reorganizacja repozytorium
          </p>
        </div>
        <h3 className="mt-1 text-base font-medium text-[#1C1A18]">
          Polecenie dla Kuratora Wiki
        </h3>
        <p className="mt-1 text-xs text-[#6B655D]">
          Wydaj polecenie utworzenia podfolderów, wydzielenia nowej strony wiki lub
          uporządkowania istniejących notatek bez opuszczania aplikacji.
        </p>

        <div className="mt-3 flex flex-col gap-2.5 sm:flex-row">
          <input
            type="text"
            value={commandText}
            onChange={(e) => setCommandText(e.target.value)}
            disabled={commandBusy}
            placeholder="Np. Zrób folder zdrowie/samopoczucie i uporządkuj notatki o zdrowiu jako oddzielną stronę wiki"
            className="flex-1 rounded-xl border border-[#DDD7CB] bg-[#FAF9F5] px-3.5 py-2 text-sm text-[#1C1A18] placeholder-[#9E978E] focus:border-[#9A4720] focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={commandBusy || !commandText.trim()}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#9A4720] px-4 py-2 text-xs font-medium text-[#FAF9F5] transition hover:bg-[#7E3817] disabled:opacity-50"
          >
            {commandBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderTree className="h-3.5 w-3.5" />
            )}
            Wykonaj w repo
          </button>
        </div>

        {commandError && (
          <p className="mt-3 rounded-lg bg-[#FDF2F0] px-3 py-2 text-xs text-[#8B2E24]">
            {commandError}
          </p>
        )}

        {commandResult && (
          <div className="mt-3 rounded-xl border border-[#DED8CB] bg-[#F5F2EA] px-3.5 py-2.5 text-xs text-[#2A2622]">
            <p className="font-medium">
              {commandResult.status === "executed"
                ? `Zastosowano: ${commandResult.summary}`
                : `Pominięto: ${commandResult.summary}`}
            </p>
            {commandResult.filesWritten.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {commandResult.filesWritten.map((filePath) => {
                  const slug = normalizeSlug(filePath.replace(/^wiki\//i, ""));
                  return (
                    <button
                      key={filePath}
                      type="button"
                      onClick={() => onOpenWikiSlug(slug)}
                      className="font-mono-meta inline-flex items-center gap-1 rounded-lg border border-[#D7CEBF] bg-[#FCFBF8] px-2.5 py-1 text-[11px] text-[#9A4720] hover:border-[#9A4720]"
                    >
                      [[{slug}]]
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </form>

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

                {job.vaultCommandSummary && (
                  <p className="mt-2 text-xs text-[#4B463F]">
                    Kurator: {job.vaultCommandSummary}
                  </p>
                )}

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

                  {job.vaultCommandFiles
                    ?.map((filePath) => normalizeSlug(filePath.replace(/^wiki\//i, "")))
                    .filter((slug) => slug !== targetSlug)
                    .map((slug) => (
                      <button
                        key={slug}
                        type="button"
                        onClick={() => onOpenWikiSlug(slug)}
                        className="font-mono-meta inline-flex items-center gap-1 text-[#9A4720] hover:underline"
                      >
                        [[{slug}]]
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    ))}

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
