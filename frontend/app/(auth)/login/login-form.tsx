"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { apiPost } from "@/lib/api";

type LoginResponse = {
  ok?: boolean;
  requiresTwoFactor?: boolean;
  challengeToken?: string;
};

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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

      const response = await apiPost<LoginResponse>("/auth/login", { username, password });
      if (response.requiresTwoFactor && response.challengeToken) {
        setChallengeToken(response.challengeToken);
        return;
      }

      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="w-full max-w-sm rounded-md border border-panel-line bg-white p-6 shadow-sm" onSubmit={submit}>
      <div className="mb-6 flex items-center gap-3">
        <ShieldCheck className="text-panel-accent" />
        <div>
          <h1 className="text-xl font-semibold">Superadmin Login</h1>
          <p className="text-sm text-panel-muted">{challengeToken ? "Enter your authenticator code" : "Access the VPS control plane"}</p>
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

      <button className="h-10 w-full rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={loading} type="submit">
        {loading ? "Checking..." : challengeToken ? "Verify code" : "Sign in"}
      </button>
    </form>
  );
}
