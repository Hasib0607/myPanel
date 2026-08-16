"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Fingerprint, ShieldCheck } from "lucide-react";
import { apiGet, apiPost, configuredSecurePanelUrl, getWebAuthnCredential, securePanelUrlFrom, webAuthnUnavailableMessage, type WebAuthnCredentialRequestOptions } from "@/lib/api";

type LoginResponse = {
  ok?: boolean;
  requiresTwoFactor?: boolean;
  challengeToken?: string;
};

type WebAuthnLoginOptionsResponse = {
  challengeToken: string;
  publicKey: WebAuthnCredentialRequestOptions;
};

type PublicConfigResponse = {
  frontendUrl: string | null;
};

export function LoginForm() {
  const router = useRouter();
  const isAccountPortal = typeof window !== "undefined" && window.location.port === (process.env.NEXT_PUBLIC_CPANEL_LOGIN_PORT ?? "3138");
  const [username, setUsername] = useState(isAccountPortal ? "" : "admin");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [publicFrontendUrl, setPublicFrontendUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const securePanelUrl = useMemo(
    () => configuredSecurePanelUrl("/login") ?? securePanelUrlFrom(publicFrontendUrl, "/login"),
    [publicFrontendUrl]
  );

  useEffect(() => {
    apiGet<PublicConfigResponse>("/auth/public-config")
      .then((config) => setPublicFrontendUrl(config.frontendUrl))
      .catch(() => setPublicFrontendUrl(null));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (challengeToken) {
        await apiPost("/auth/login/2fa", { challengeToken, token: totp });
        router.replace("/dashboard");
        return;
      }

      const response = await apiPost<LoginResponse>(isAccountPortal ? "/auth/account/login" : "/auth/login", { username, password });
      if (response.requiresTwoFactor && response.challengeToken) {
        setChallengeToken(response.challengeToken);
        return;
      }

      router.replace(isAccountPortal ? "/account" : "/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function submitDeviceLogin() {
    setError("");
    setLoading(true);

    try {
      const unavailable = webAuthnUnavailableMessage();
      if (unavailable) throw new Error(securePanelUrl ? `${unavailable} Open ${securePanelUrl}` : unavailable);
      const options = await apiPost<WebAuthnLoginOptionsResponse>("/auth/login/webauthn/options", { username });
      const credential = await getWebAuthnCredential(options.publicKey);
      await apiPost<LoginResponse>("/auth/login/webauthn/verify", {
        username,
        challengeToken: options.challengeToken,
        credential
      });
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Biometric login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="w-full max-w-sm rounded-md border border-panel-line bg-white p-6 shadow-sm" onSubmit={submit}>
      <div className="mb-6 flex items-center gap-3">
        <ShieldCheck className="text-panel-accent" />
        <div>
          <h1 className="text-xl font-semibold">{isAccountPortal ? "Account Login" : "Superadmin Login"}</h1>
          <p className="text-sm text-panel-muted">{challengeToken ? "Enter your authenticator code" : isAccountPortal ? "Access your hosting account" : "Access the VPS control plane"}</p>
        </div>
      </div>

      {!challengeToken ? (
        <>
          <label className="mb-3 block text-sm font-medium">
            Username
            <input className="mt-1 h-10 w-full rounded-md border border-panel-line px-3" onChange={(event) => setUsername(event.target.value)} value={username} />
          </label>
          <label className="mb-5 block text-sm font-medium">
            Password
            <input className="mt-1 h-10 w-full rounded-md border border-panel-line px-3" onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
          </label>
        </>
      ) : (
        <label className="mb-5 block text-sm font-medium">
          Authenticator code
          <input
            autoComplete="one-time-code"
            className="mt-1 h-10 w-full rounded-md border border-panel-line px-3 tracking-widest"
            inputMode="numeric"
            maxLength={6}
            onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))}
            value={totp}
          />
        </label>
      )}

      {error ? <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-panel-danger">{error}</div> : null}
      {error && securePanelUrl && error.includes("requires HTTPS") ? (
        <a className="mb-4 block rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900 underline" href={securePanelUrl}>
          Open secure panel URL
        </a>
      ) : null}

      <button className="h-10 w-full rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={loading} type="submit">
        {loading ? "Checking..." : challengeToken ? "Verify code" : "Sign in"}
      </button>
      {!challengeToken && !isAccountPortal ? (
        <button
          className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-md border border-panel-line px-4 text-sm font-semibold text-panel-ink hover:bg-slate-50 disabled:opacity-60"
          disabled={loading}
          onClick={submitDeviceLogin}
          type="button"
        >
          <Fingerprint size={16} /> Use device fingerprint
        </button>
      ) : null}
    </form>
  );
}
