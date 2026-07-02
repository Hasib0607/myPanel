"use client";

export type TokenExpiryMode = "unlimited" | "date";

export type TokenExpiryInfo = {
  unlimited?: boolean;
  expiresAt?: string | null;
  expiresInSeconds?: number | null;
};

export function defaultTokenDateTimeLocal() {
  const date = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  date.setSeconds(0, 0);
  return toDateTimeLocalValue(date);
}

export function toDateTimeLocalValue(date: Date) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

export function tokenExpiryBody(mode: TokenExpiryMode, expiresAt: string) {
  if (mode === "unlimited") return { unlimited: true, expiresAt: null };
  return { expiresAt: new Date(expiresAt).toISOString() };
}

export function tokenExpiryText(token: TokenExpiryInfo) {
  if (token.unlimited || token.expiresAt === null || token.expiresInSeconds === null) return "No expiry";
  if (token.expiresAt) return `Valid until ${new Date(token.expiresAt).toLocaleString()}`;
  return `Expires in ${Math.round((token.expiresInSeconds ?? 0) / 86400)} day(s)`;
}

export function TokenExpiryControls({ mode, setMode, expiresAt, setExpiresAt }: { mode: TokenExpiryMode; setMode: (mode: TokenExpiryMode) => void; expiresAt: string; setExpiresAt: (value: string) => void }) {
  return (
    <div className="rounded-md border border-panel-line bg-slate-50 p-3">
      <div className="mb-2 text-xs font-semibold uppercase text-panel-muted">Token validity</div>
      <div className="grid gap-3 md:grid-cols-[220px_1fr]">
        <div className="grid grid-cols-2 gap-2">
          <button className={`h-9 rounded-md border text-xs font-semibold ${mode === "unlimited" ? "border-panel-accent bg-white text-panel-accent" : "border-panel-line bg-white text-panel-muted"}`} onClick={() => setMode("unlimited")} type="button">Unlimited</button>
          <button className={`h-9 rounded-md border text-xs font-semibold ${mode === "date" ? "border-panel-accent bg-white text-panel-accent" : "border-panel-line bg-white text-panel-muted"}`} onClick={() => setMode("date")} type="button">Until date</button>
        </div>
        <input className="h-9 rounded-md border border-panel-line bg-white px-3 text-sm disabled:opacity-60" disabled={mode !== "date"} min={toDateTimeLocalValue(new Date(Date.now() + 60_000))} onChange={(event) => setExpiresAt(event.target.value)} type="datetime-local" value={expiresAt} />
      </div>
    </div>
  );
}
