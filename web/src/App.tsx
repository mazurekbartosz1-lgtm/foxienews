export function App() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <header className="border-b border-[#e2dfd4] pb-6">
        <p className="font-sans text-xs tracking-widest text-[#6b675e] uppercase">
          Foxie Notes · Szkielet Etap 2
        </p>
        <h1 className="mt-2 text-3xl font-normal tracking-tight text-[#1c1917]">
          Prywatna baza wiedzy i zadań
        </h1>
      </header>

      <section className="mt-8 space-y-4 font-sans text-sm leading-relaxed text-[#44403c]">
        <p>
          To jest minimalistyczny szkielet aplikacji webowej (Etap 2). Po zakończeniu Etapu 1
          (symulator e-ink, firmware Waveshare oraz endpoint <code>POST /api/capture</code>)
          zostaną tu uruchomione:
        </p>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>Logowanie Firebase Auth ograniczone do jednego konta (whitelist)</li>
          <li>Widok „Do zrobienia” z zadaniami z vaulta i szybkim formularzem notatek</li>
          <li>Widok „Wiki” ze spisem treści, wyszukiwarką i klikalnymi <code>[[wikilinks]]</code></li>
        </ul>
      </section>
    </main>
  );
}
