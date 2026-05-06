"use client";

import Image from "next/image";
import { FormEvent, useEffect, useState } from "react";
import { KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";

type TwoFactorStatus = {
  enabled: boolean;
};

type SetupResponse = {
  secret: string;
  uri: string;
  qrCodeDataUrl: string;
};

export function TwoFactorPanel() {
  const [enabled, setEnabled] = useState(false);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiGet<TwoFactorStatus>("/auth/2fa/status")
      .then((status) => setEnabled(status.enabled))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load 2FA status"));
  }, []);

  async function beginSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const response = await apiPost<SetupResponse>("/auth/2fa/setup", { password });
      setSetup(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start 2FA setup");
    } finally {
      setLoading(false);
    }
  }

  async function enable2fa() {
    if (!setup) return;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      await apiPost("/auth/2fa/enable", { secret: setup.secret, token });
      setEnabled(true);
      setSetup(null);
      setPassword("");
      setToken("");
      setMessage("Two-factor authentication is enabled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not enable 2FA");
    } finally {
      setLoading(false);
    }
  }

  async function disable2fa() {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      await apiPost("/auth/2fa/disable", { password });
      setEnabled(false);
      setSetup(null);
      setPassword("");
      setToken("");
      setMessage("Two-factor authentication is disabled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disable 2FA");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-md border border-panel-line bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          {enabled ? <ShieldCheck className="text-panel-accent" /> : <ShieldOff className="text-panel-warn" />}
          <div>
            <div className="text-sm font-semibold">Authenticator App 2FA</div>
            <div className="text-sm text-panel-muted">Use Google Authenticator, Microsoft Authenticator, Authy, 1Password, or Bitwarden.</div>
          </div>
        </div>
        <span className={`rounded-md px-2 py-1 text-xs font-semibold ${enabled ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
          {enabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      <form className="mt-5 flex max-w-md gap-2" onSubmit={beginSetup}>
        <input
          className="h-10 min-w-0 flex-1 rounded-md border border-panel-line px-3 text-sm"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Confirm superadmin password"
          type="password"
          value={password}
        />
        {!enabled ? (
          <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={loading} type="submit">
            <KeyRound size={16} />
            Set up
          </button>
        ) : (
          <button className="h-10 rounded-md border border-panel-line px-3 text-sm font-semibold text-panel-danger disabled:opacity-60" disabled={loading || !password} onClick={disable2fa} type="button">
            Disable
          </button>
        )}
      </form>

      {setup ? (
        <div className="mt-5 grid max-w-2xl grid-cols-[180px_1fr] gap-5 rounded-md border border-panel-line p-4">
          <Image alt="Authenticator QR code" className="rounded-md border border-panel-line" height={180} src={setup.qrCodeDataUrl} width={180} unoptimized />
          <div className="space-y-3">
            <div>
              <div className="text-sm font-semibold">Scan QR code</div>
              <div className="text-sm text-panel-muted">Then enter the 6-digit code from your mobile app.</div>
            </div>
            <input
              className="h-10 w-40 rounded-md border border-panel-line px-3 tracking-widest"
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => setToken(event.target.value.replace(/\D/g, ""))}
              placeholder="000000"
              value={token}
            />
            <button className="h-10 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={loading || token.length !== 6} onClick={enable2fa} type="button">
              Enable 2FA
            </button>
          </div>
        </div>
      ) : null}

      {message ? <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{message}</div> : null}
      {error ? <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-panel-danger">{error}</div> : null}
    </div>
  );
}
