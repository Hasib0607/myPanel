"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox } from "lucide-react";
import { apiPost } from "@/lib/api";

export default function WebmailLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const response = await apiPost<{ redirectTo?: string }>("/auth/mail/login", { username: email, password });
      router.replace(response.redirectTo ?? "/webmail");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mailbox login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-panel-bg px-4">
      <form className="w-full max-w-sm rounded-md border border-panel-line bg-white p-6 shadow-sm" onSubmit={submit}>
        <div className="mb-6 flex items-center gap-3">
          <Inbox className="text-panel-accent" />
          <div>
            <h1 className="text-xl font-semibold">Webmail Login</h1>
            <p className="text-sm text-panel-muted">Sign in with your full email address.</p>
          </div>
        </div>
        <label className="mb-3 block text-sm font-medium">
          Email address
          <input autoComplete="username" className="mt-1 h-10 w-full rounded-md border border-panel-line px-3" onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" type="email" value={email} />
        </label>
        <label className="mb-5 block text-sm font-medium">
          Password
          <input autoComplete="current-password" className="mt-1 h-10 w-full rounded-md border border-panel-line px-3" onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
        </label>
        {error ? <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-panel-danger">{error}</div> : null}
        <button className="h-10 w-full rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={loading || !email || !password} type="submit">
          {loading ? "Checking..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
