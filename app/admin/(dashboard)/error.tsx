"use client";

export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const missingEnv = /Missing required env var (\w+)/.exec(error.message)?.[1];
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      <h2 className="font-semibold">Couldn&apos;t load this page</h2>
      <p className="mt-2">
        {missingEnv
          ? `${missingEnv} is not set. Add it to .env.local (or Vercel env vars) and reload.`
          : "The database request failed. Check the server logs for details."}
      </p>
      {error.digest && <p className="mt-2 font-mono text-xs opacity-70">Ref: {error.digest}</p>}
      <button type="button" onClick={reset} className="mt-4 underline">
        Try again
      </button>
    </div>
  );
}
