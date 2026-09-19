// Read env at request time, not at build time.
export const dynamic = "force-dynamic";

const ENV_GROUPS: Record<string, string[][]> = {
  Luma: [["LUMA_API_KEY"], ["LUMA_WEBHOOK_SECRET"]],
  Supabase: [["SUPABASE_URL"], ["SUPABASE_SERVICE_ROLE_KEY"]],
  "Upstash Redis": [
    ["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"],
    ["UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"],
  ],
  OpenAI: [["OPENAI_API_KEY"]],
  Telegram: [["TELEGRAM_BOT_TOKEN"], ["TELEGRAM_WEBHOOK_SECRET"]],
};

const ENDPOINTS = [
  { path: "/api/webhooks/luma", note: "Luma guest.registered webhook (signed)" },
  { path: "/api/telegram/action", note: "Telegram button callbacks (secret-token checked)" },
];

export default function Home() {
  // Config status is dev-only so a public deploy never reveals what is configured.
  const showStatus = process.env.NODE_ENV !== "production";

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-16 font-sans">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">LumaOps Agent</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Guardrailed event ops for Visible Builders. Backend only for now: webhooks in, Telegram
          decision cards out.
        </p>
      </header>

      {showStatus && (
        <>
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
              Environment (dev only)
            </h2>
            <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {Object.entries(ENV_GROUPS).flatMap(([group, vars]) =>
                vars.map((names) => {
                  const isSet = names.some((n) => Boolean(process.env[n]));
                  return (
                    <li key={names[0]} className="flex items-center justify-between px-4 py-2.5 text-sm">
                      <span>
                        <span className="text-zinc-500">{group} · </span>
                        <code className="font-mono">{names[0]}</code>
                      </span>
                      <span className={isSet ? "text-emerald-600" : "text-red-600"}>
                        {isSet ? "✓ set" : "✗ missing"}
                      </span>
                    </li>
                  );
                }),
              )}
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
              Endpoints (POST)
            </h2>
            <ul className="space-y-2 text-sm">
              {ENDPOINTS.map((e) => (
                <li key={e.path}>
                  <code className="font-mono">{e.path}</code>
                  <span className="text-zinc-500"> — {e.note}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
