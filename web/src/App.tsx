import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { BookOpen, Bot, CheckSquare, Loader2, LogOut } from "lucide-react";
import { AgentsActivityView } from "./components/AgentsActivityView";
import { FoxieMark } from "./components/FoxieMark";
import { LoginPage } from "./components/LoginPage";
import { TasksView } from "./components/TasksView";
import { WikiView } from "./components/WikiView";
import {
  isAllowedUser,
  signOutUser,
  subscribeToAuthChanges,
} from "./lib/firebase";

type ActiveTab = "tasks" | "wiki" | "agents";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>("tasks");
  const [selectedWikiSlug, setSelectedWikiSlug] = useState("");

  useEffect(() => {
    const unsub = subscribeToAuthChanges((nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
    });
    return unsub;
  }, []);

  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F7F5F0] text-sm text-[#7A756D]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Sprawdzanie sesji Foxie Notes...
      </div>
    );
  }

  if (!user || !isAllowedUser(user)) {
    return <LoginPage unauthorizedUser={user} />;
  }

  const openWikiSlug = (slug: string) => {
    setSelectedWikiSlug(slug);
    setActiveTab("wiki");
  };

  return (
    <div className="min-h-screen bg-[#F7F5F0] text-[#1C1A18]">
      <header className="sticky top-0 z-20 border-b border-[#E4DFD4] bg-[#F7F5F0]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <FoxieMark className="h-9 w-9 shrink-0" />
            <div>
              <span className="block text-base font-medium tracking-tight text-[#1C1A18]">
                Foxie Notes
              </span>
              <span className="font-mono-meta hidden text-[11px] text-[#8E887E] sm:block">
                {user.email}
              </span>
            </div>
          </div>

          <nav className="flex items-center gap-1.5">
            {(
              [
                ["tasks", "Do zrobienia", CheckSquare],
                ["wiki", "Wiki", BookOpen],
                ["agents", "Agenci", Bot],
              ] as const
            ).map(([tabKey, label, Icon]) => {
              const active = activeTab === tabKey;
              return (
                <button
                  key={tabKey}
                  type="button"
                  onClick={() => setActiveTab(tabKey)}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-medium transition sm:text-sm ${
                    active
                      ? "bg-[#1C1A18] text-[#FAF9F5]"
                      : "text-[#5C574F] hover:bg-[#EDE9DF]"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => signOutUser()}
              title="Wyloguj"
              className="ml-1 inline-flex items-center gap-1.5 rounded-xl border border-[#E4DFD4] bg-[#FCFBF8] px-3 py-2 text-xs font-medium text-[#5C574F] transition hover:bg-[#EDE9DF] hover:text-[#1C1A18]"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Wyloguj</span>
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {activeTab === "tasks" && <TasksView onOpenWikiSlug={openWikiSlug} />}
        {activeTab === "wiki" && (
          <WikiView
            selectedSlug={selectedWikiSlug}
            onSelectSlug={setSelectedWikiSlug}
          />
        )}
        {activeTab === "agents" && (
          <AgentsActivityView onOpenWikiSlug={openWikiSlug} />
        )}
      </main>
    </div>
  );
}
