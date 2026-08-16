"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Fingerprint, Github, KeyRound, RotateCcw, Save, Settings2, Trash2 } from "lucide-react";
import { apiDelete, apiGet, apiPost, apiPut, createWebAuthnCredential, webAuthnUnavailableMessage, type WebAuthnCredentialCreationOptions } from "@/lib/api";

type SettingsResponse = {
  username: string;
  envFile: string;
  entries: Array<{ key: string; value: string; masked: boolean; secret: boolean }>;
};

type EnvSaveResponse = {
  ok: boolean;
  updated: string[];
  restartRequired: boolean;
};

type DeviceLoginResponse = {
  currentDeviceRegistered: boolean;
  currentDeviceNeedsBiometricUpdate?: boolean;
  devices: Array<{
    id: string;
    label: string | null;
    userAgent: string | null;
    createdAt: string;
    lastUsedAt: string | null;
    biometricRegistered: boolean;
    current: boolean;
  }>;
};

type WebAuthnRegistrationOptionsResponse = {
  challengeToken: string;
  publicKey: WebAuthnCredentialCreationOptions;
};

export function SettingsClient() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<SettingsResponse>("/settings")
  });
  const deviceLogin = useQuery({
    queryKey: ["settings-device-login"],
    queryFn: () => apiGet<DeviceLoginResponse>("/settings/device-login")
  });
  const [password, setPassword] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [trustedDevice, setTrustedDevice] = useState({ currentPassword: "", label: "" });
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");
  const [biometricUnavailable, setBiometricUnavailable] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    const next: Record<string, string> = {};
    for (const entry of settings.data.entries) next[entry.key] = entry.value;
    setEnvDraft(next);
  }, [settings.data]);

  useEffect(() => {
    setBiometricUnavailable(webAuthnUnavailableMessage());
  }, []);

  const visibleEntries = useMemo(() => settings.data?.entries ?? [], [settings.data]);

  const changePassword = useMutation({
    mutationFn: () => apiPost("/settings/password", {
      currentPassword: password.currentPassword,
      newPassword: password.newPassword
    }),
    onSuccess: () => {
      setPassword({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setNotice("Panel password changed.");
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not change password.")
  });

  const saveEnv = useMutation({
    mutationFn: () => apiPut<EnvSaveResponse>("/settings/env", {
      entries: visibleEntries
        .map((entry) => ({ key: entry.key, value: envDraft[entry.key] ?? "" }))
        .filter((entry) => {
          const original = visibleEntries.find((item) => item.key === entry.key);
          if (!original) return false;
          if (original.secret && original.masked && entry.value.trim() === "") return false;
          return entry.value !== original.value;
        })
    }),
    onSuccess: async (result) => {
      setNotice(result.updated.length > 0 ? `Saved ${result.updated.length} setting(s). Restart affected services to apply runtime-only changes.` : "No changes to save.");
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not save environment.")
  });

  const registerDeviceLogin = useMutation({
    mutationFn: async () => {
      const options = await apiPost<WebAuthnRegistrationOptionsResponse>("/settings/device-login/options", {
        currentPassword: trustedDevice.currentPassword,
        label: trustedDevice.label.trim() || undefined
      });
      const credential = await createWebAuthnCredential(options.publicKey);
      return apiPost("/settings/device-login/verify", {
        challengeToken: options.challengeToken,
        credential
      });
    },
    onSuccess: async () => {
      setTrustedDevice({ currentPassword: "", label: "" });
      setNotice("Biometric login enabled for this browser.");
      await queryClient.invalidateQueries({ queryKey: ["settings-device-login"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not register this device.")
  });

  const revokeDeviceLogin = useMutation({
    mutationFn: (id: string) => apiDelete(`/settings/device-login/${id}`),
    onSuccess: async () => {
      setNotice("Trusted device removed.");
      await queryClient.invalidateQueries({ queryKey: ["settings-device-login"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not remove trusted device.")
  });

  const passwordInvalid = password.newPassword.length < 10 || password.newPassword !== password.confirmPassword || !password.currentPassword;
  const deviceRegistrationDisabled = !trustedDevice.currentPassword || registerDeviceLogin.isPending;

  return (
    <section className="space-y-5 p-6">
      <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
        <div className="space-y-5">
          <div className="rounded-md border border-panel-line bg-white">
            <div className="flex items-center gap-3 border-b border-panel-line px-4 py-3">
              <span className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-white"><KeyRound size={17} /></span>
              <div>
                <div className="text-sm font-semibold text-panel-ink">Panel password</div>
                <div className="text-xs text-panel-muted">Signed in as {settings.data?.username ?? "admin"}</div>
              </div>
            </div>
            <div className="space-y-3 p-4">
              <Field label="Current password" type="password" value={password.currentPassword} onChange={(currentPassword) => setPassword({ ...password, currentPassword })} />
              <Field label="New password" type="password" value={password.newPassword} onChange={(newPassword) => setPassword({ ...password, newPassword })} />
              <Field label="Confirm password" type="password" value={password.confirmPassword} onChange={(confirmPassword) => setPassword({ ...password, confirmPassword })} />
              <button
                className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60"
                disabled={passwordInvalid || changePassword.isPending}
                onClick={() => changePassword.mutate()}
                type="button"
              >
                <Save size={16} /> {changePassword.isPending ? "Saving..." : "Change password"}
              </button>
            </div>
          </div>

          <div className="rounded-md border border-panel-line bg-white">
            <div className="flex items-center gap-3 border-b border-panel-line px-4 py-3">
              <span className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-white"><Fingerprint size={17} /></span>
              <div>
                <div className="text-sm font-semibold text-panel-ink">Biometric device login</div>
                <div className="text-xs text-panel-muted">
                  {deviceLogin.data?.currentDeviceRegistered
                    ? "This browser can sign in with fingerprint or passkey."
                    : deviceLogin.data?.currentDeviceNeedsBiometricUpdate
                      ? "This browser has the old trusted-device record. Update it once to add biometric login."
                      : "Register this browser with your current password."}
                </div>
              </div>
            </div>
            <div className="space-y-3 p-4">
              <Field label="Device label" value={trustedDevice.label} onChange={(label) => setTrustedDevice({ ...trustedDevice, label })} />
              <Field label="Current password" type="password" value={trustedDevice.currentPassword} onChange={(currentPassword) => setTrustedDevice({ ...trustedDevice, currentPassword })} />
              {biometricUnavailable ? <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{biometricUnavailable}</div> : null}
              <button
                className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60"
                disabled={deviceRegistrationDisabled}
                onClick={() => registerDeviceLogin.mutate()}
                type="button"
              >
                <Fingerprint size={16} /> {registerDeviceLogin.isPending ? "Registering..." : deviceLogin.data?.currentDeviceRegistered || deviceLogin.data?.currentDeviceNeedsBiometricUpdate ? "Update this device" : "Register this device"}
              </button>

              {deviceLogin.data?.devices.length ? (
                <div className="space-y-2 pt-1">
                  {deviceLogin.data.devices.map((device) => (
                    <div className="rounded-md border border-panel-line p-3" key={device.id}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-panel-ink">
                            {device.label ?? "Registered device"} {device.current ? <span className="text-xs text-panel-accent">Current</span> : null}
                          </div>
                          <div className="mt-1 truncate text-xs text-panel-muted">{device.userAgent ?? "Unknown browser"}</div>
                          <div className="mt-1 text-xs text-panel-muted">{device.biometricRegistered ? "Biometric credential registered" : "Needs biometric update"}</div>
                          <div className="mt-1 text-xs text-panel-muted">
                            {device.lastUsedAt ? `Last used ${formatDateTime(device.lastUsedAt)}` : `Added ${formatDateTime(device.createdAt)}`}
                          </div>
                        </div>
                        <button
                          className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-red-200 text-panel-danger hover:bg-red-50 disabled:opacity-60"
                          disabled={revokeDeviceLogin.isPending}
                          onClick={() => revokeDeviceLogin.mutate(device.id)}
                          title="Remove trusted device"
                          type="button"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <Link className="block rounded-md border border-panel-line bg-white p-4 transition-colors hover:border-panel-accent hover:bg-slate-50" href="/settings/git">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-white"><Github size={17} /></span>
              <div>
                <div className="text-sm font-semibold text-panel-ink">Git connection</div>
                <div className="text-xs text-panel-muted">Connect, reconnect, or disconnect GitHub for deploy source sync.</div>
              </div>
            </div>
          </Link>
        </div>

        <div className="rounded-md border border-panel-line bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-panel-line px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-white"><Settings2 size={17} /></span>
              <div>
                <div className="text-sm font-semibold text-panel-ink">Environment</div>
                <div className="text-xs text-panel-muted">{settings.data?.envFile ?? "Panel .env"}</div>
              </div>
            </div>
            <div className="flex gap-2">
              <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium hover:bg-slate-50" onClick={() => settings.refetch()} type="button">
                <RotateCcw size={15} /> Refresh
              </button>
              <button className="flex h-9 items-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={saveEnv.isPending} onClick={() => saveEnv.mutate()} type="button">
                <Save size={15} /> {saveEnv.isPending ? "Saving..." : "Save env"}
              </button>
            </div>
          </div>

          <div className="max-h-[calc(100vh-190px)] overflow-auto">
            <table className="min-w-full divide-y divide-panel-line text-left text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-panel-muted">
                <tr>
                  <th className="w-72 px-4 py-3">Key</th>
                  <th className="px-4 py-3">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-panel-line">
                {visibleEntries.map((entry) => {
                  const showSecret = revealed[entry.key] || !entry.secret;
                  return (
                    <tr key={entry.key}>
                      <td className="px-4 py-3 font-mono text-xs text-panel-ink">{entry.key}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <input
                            className="h-10 min-w-0 flex-1 rounded-md border border-panel-line px-3 font-mono text-xs"
                            onChange={(event) => setEnvDraft({ ...envDraft, [entry.key]: event.target.value })}
                            placeholder={entry.secret && entry.masked ? "Leave blank to keep current value" : ""}
                            type={showSecret ? "text" : "password"}
                            value={envDraft[entry.key] ?? ""}
                          />
                          {entry.secret ? (
                            <button
                              className="grid h-10 w-10 place-items-center rounded-md border border-panel-line hover:bg-slate-50"
                              onClick={() => setRevealed({ ...revealed, [entry.key]: !revealed[entry.key] })}
                              title={showSecret ? "Hide value" : "Show value"}
                              type="button"
                            >
                              {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {notice ? (
        <div className="rounded-md border border-panel-line bg-white px-4 py-3 text-sm text-panel-ink">{notice}</div>
      ) : null}
    </section>
  );
}

function formatDateTime(value: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-panel-ink">{label}</span>
      <input className="h-10 w-full rounded-md border border-panel-line px-3" onChange={(event) => onChange(event.target.value)} type={type} value={value} />
    </label>
  );
}
