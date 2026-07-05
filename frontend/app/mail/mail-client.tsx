"use client";

import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, FileText, Inbox, Mail, Search, Send, Star, Trash2 } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { MailMessageBody } from "@/components/mail-message-body";

type Folder = "INBOX" | "SENT" | "DRAFTS" | "SPAM" | "TRASH";

type MailAccount = {
  id: string;
  username: string;
  enabled: boolean;
  quotaMb: number;
  domain: { name: string };
};

type FolderCount = {
  folder: Folder;
  count: number;
};

type MailMessage = {
  id: string;
  messageId: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  bodyText?: string | null;
  bodyHtml?: string | null;
  deliveryStatus: string;
  deliveryError?: string | null;
  folder: Folder;
  isRead: boolean;
  isStarred: boolean;
  receivedAt: string;
};

const folders: Array<{ key: Folder; label: string; icon: typeof Inbox }> = [
  { key: "INBOX", label: "Inbox", icon: Inbox },
  { key: "SENT", label: "Sent", icon: Send },
  { key: "DRAFTS", label: "Drafts", icon: FileText },
  { key: "SPAM", label: "Spam", icon: Archive },
  { key: "TRASH", label: "Trash", icon: Trash2 }
];

function formatAddress(account?: MailAccount) {
  return account ? `${account.username}@${account.domain.name}` : "";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function MailClient({ domainId, composeFirst = false }: { domainId?: string; composeFirst?: boolean }) {
  const queryClient = useQueryClient();
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [folder, setFolder] = useState<Folder>("INBOX");
  const [search, setSearch] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [selectedMessageId, setSelectedMessageId] = useState("");
  const [composeOpen, setComposeOpen] = useState(composeFirst);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");

  const accountPath = domainId ? `/mail/accounts?domainId=${domainId}` : "/mail/accounts";
  const accounts = useQuery({
    queryKey: ["webmail-accounts", domainId],
    queryFn: () => apiGet<MailAccount[]>(accountPath)
  });

  const activeAccountId = selectedAccountId || accounts.data?.[0]?.id || "";
  const activeAccount = accounts.data?.find((account) => account.id === activeAccountId);

  const messagePath = useMemo(() => {
    if (!activeAccountId) return "";
    const params = new URLSearchParams({ folder });
    if (search) params.set("search", search);
    return `/mail/accounts/${activeAccountId}/messages?${params.toString()}`;
  }, [activeAccountId, folder, search]);

  const folderCounts = useQuery({
    enabled: Boolean(activeAccountId),
    queryKey: ["webmail-folders", activeAccountId],
    queryFn: () => apiGet<FolderCount[]>(`/mail/accounts/${activeAccountId}/folders`)
  });

  const messages = useQuery({
    enabled: Boolean(messagePath),
    queryKey: ["webmail-messages", activeAccountId, folder, search],
    queryFn: () => apiGet<MailMessage[]>(messagePath)
  });

  const selectedMessage = messages.data?.find((message) => message.id === selectedMessageId) ?? messages.data?.[0];

  const invalidateMailbox = async () => {
    await queryClient.invalidateQueries({ queryKey: ["webmail-folders", activeAccountId] });
    await queryClient.invalidateQueries({ queryKey: ["webmail-messages", activeAccountId] });
  };

  const updateMessage = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<MailMessage, "isRead" | "isStarred" | "folder">> }) => apiPatch(`/mail/messages/${id}`, patch),
    onSuccess: invalidateMailbox,
    onError: (err) => setError(err instanceof Error ? err.message : "Could not update message")
  });

  const deleteMessage = useMutation({
    mutationFn: (id: string) => apiDelete(`/mail/messages/${id}`),
    onSuccess: async () => {
      setSelectedMessageId("");
      await invalidateMailbox();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not move message")
  });

  const sendMessage = useMutation({
    mutationFn: () => apiPost("/mail/compose", { accountId: activeAccountId, to, subject, html: body, text: body }),
    onSuccess: async () => {
      setTo("");
      setSubject("");
      setBody("");
      setComposeOpen(false);
      setFolder("SENT");
      setError("");
      await invalidateMailbox();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not queue message")
  });

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(draftSearch.trim());
    setSelectedMessageId("");
  }

  function submitCompose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    sendMessage.mutate();
  }

  return (
    <section className="space-y-4 p-8">
      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-md border border-panel-line bg-white p-4">
          <div className="text-xs text-panel-muted">Accounts</div>
          <div className="mt-1 text-2xl font-semibold">{accounts.data?.length ?? 0}</div>
        </div>
        <div className="rounded-md border border-panel-line bg-white p-4">
          <div className="text-xs text-panel-muted">Selected mailbox</div>
          <div className="mt-1 truncate text-lg font-semibold">{formatAddress(activeAccount) || "None"}</div>
        </div>
        <div className="rounded-md border border-panel-line bg-white p-4">
          <div className="text-xs text-panel-muted">Messages in folder</div>
          <div className="mt-1 text-2xl font-semibold">{messages.data?.length ?? 0}</div>
        </div>
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
          <div className="text-xs text-amber-700">Transport</div>
          <div className="mt-1 text-sm font-semibold text-amber-800">Postfix queue</div>
        </div>
      </div>

      {error || accounts.isError || messages.isError ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-panel-danger">
          {error || (accounts.error instanceof Error ? accounts.error.message : "") || (messages.error instanceof Error ? messages.error.message : "Could not load webmail")}
        </div>
      ) : null}

      <div className="grid min-h-[620px] grid-cols-[260px_minmax(320px,0.9fr)_minmax(420px,1.4fr)] rounded-md border border-panel-line bg-white">
        <aside className="border-r border-panel-line p-4">
          <label className="mb-2 block text-xs font-semibold uppercase text-panel-muted">Mailbox</label>
          <select
            className="mb-4 h-10 w-full rounded-md border border-panel-line px-3 text-sm"
            onChange={(event) => {
              setSelectedAccountId(event.target.value);
              setSelectedMessageId("");
            }}
            value={activeAccountId}
          >
            {(accounts.data ?? []).map((account) => (
              <option key={account.id} value={account.id}>
                {formatAddress(account)}
              </option>
            ))}
          </select>

          <button
            className="mb-4 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-60"
            disabled={!activeAccountId}
            onClick={() => setComposeOpen(true)}
            type="button"
          >
            <Mail size={16} />
            Compose
          </button>

          <div className="space-y-1">
            {folders.map((item) => {
              const Icon = item.icon;
              const count = folderCounts.data?.find((entry) => entry.folder === item.key)?.count ?? 0;
              return (
                <button
                  className={`flex h-10 w-full items-center justify-between rounded-md px-3 text-sm ${folder === item.key ? "bg-slate-100 font-semibold" : "hover:bg-slate-50"}`}
                  key={item.key}
                  onClick={() => {
                    setFolder(item.key);
                    setSelectedMessageId("");
                  }}
                  type="button"
                >
                  <span className="flex items-center gap-2">
                    <Icon size={16} />
                    {item.label}
                  </span>
                  <span className="text-xs text-panel-muted">{count}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <div className="border-r border-panel-line">
          <form className="flex gap-2 border-b border-panel-line p-3" onSubmit={submitSearch}>
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-3 text-panel-muted" size={16} />
              <input
                className="h-10 w-full rounded-md border border-panel-line pl-9 pr-3 text-sm"
                onChange={(event) => setDraftSearch(event.target.value)}
                placeholder="Search messages"
                value={draftSearch}
              />
            </div>
            <button className="h-10 rounded-md border border-panel-line px-3 text-sm font-semibold" type="submit">
              Search
            </button>
          </form>
          <div className="max-h-[566px] overflow-y-auto">
            {(messages.data ?? []).map((message) => (
              <button
                className={`block w-full border-b border-panel-line p-4 text-left hover:bg-slate-50 ${selectedMessage?.id === message.id ? "bg-slate-50" : ""}`}
                key={message.id}
                onClick={() => {
                  setSelectedMessageId(message.id);
                  if (!message.isRead) updateMessage.mutate({ id: message.id, patch: { isRead: true } });
                }}
                type="button"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className={`truncate text-sm ${message.isRead ? "text-slate-700" : "font-semibold text-slate-950"}`}>{message.fromAddress}</span>
                  <span className="shrink-0 text-xs text-panel-muted">{formatDate(message.receivedAt)}</span>
                </div>
                <div className={`truncate text-sm ${message.isRead ? "text-panel-muted" : "font-semibold"}`}>{message.subject}</div>
              </button>
            ))}
            {messages.data?.length === 0 ? (
              <div className="p-8 text-center text-sm text-panel-muted">No messages in this folder</div>
            ) : null}
          </div>
        </div>

        <main className="min-w-0 p-5">
          {composeOpen ? (
            <form className="space-y-4" onSubmit={submitCompose}>
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Compose</h2>
                <button className="rounded-md border border-panel-line px-3 py-2 text-sm hover:bg-slate-50" onClick={() => setComposeOpen(false)} type="button">
                  Close
                </button>
              </div>
              <div className="text-sm text-panel-muted">From: {formatAddress(activeAccount)}</div>
              <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setTo(event.target.value)} placeholder="to@example.com" type="email" value={to} />
              <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setSubject(event.target.value)} placeholder="Subject" value={subject} />
              <textarea className="min-h-80 w-full rounded-md border border-panel-line p-3 text-sm" onChange={(event) => setBody(event.target.value)} placeholder="Message" value={body} />
              <button
                className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60"
                disabled={!activeAccountId || !to || !subject || !body || sendMessage.isPending}
                type="submit"
              >
                <Send size={16} />
                Queue Send
              </button>
            </form>
          ) : selectedMessage ? (
            <article>
              <div className="mb-4 flex items-start justify-between gap-4 border-b border-panel-line pb-4">
                <div className="min-w-0">
                  <h2 className="truncate text-xl font-semibold">{selectedMessage.subject}</h2>
                  <div className="mt-2 text-sm text-panel-muted">From {selectedMessage.fromAddress}</div>
                  <div className="text-sm text-panel-muted">To {selectedMessage.toAddress}</div>
                  {selectedMessage.folder === "SENT" ? <div className={`mt-2 text-xs font-semibold ${selectedMessage.deliveryStatus === "FAILED" ? "text-red-600" : selectedMessage.deliveryStatus === "SENT" ? "text-emerald-600" : "text-amber-600"}`}>{selectedMessage.deliveryStatus}</div> : null}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line hover:bg-slate-50"
                    onClick={() => updateMessage.mutate({ id: selectedMessage.id, patch: { isStarred: !selectedMessage.isStarred } })}
                    title={selectedMessage.isStarred ? "Unstar" : "Star"}
                    type="button"
                  >
                    <Star className={selectedMessage.isStarred ? "fill-amber-400 text-amber-500" : ""} size={16} />
                  </button>
                  <button
                    className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-panel-danger hover:bg-red-50"
                    onClick={() => deleteMessage.mutate(selectedMessage.id)}
                    title="Move to trash"
                    type="button"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              {selectedMessage.deliveryError ? <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{selectedMessage.deliveryError}</div> : null}
              <MailMessageBody message={selectedMessage} />
            </article>
          ) : (
            <div className="rounded-md border border-dashed border-panel-line p-8 text-center text-sm text-panel-muted">
              Select a mailbox message or compose a new message
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
