"use client";

import { Fragment } from "react";

type MessageBody = {
  bodyHtml?: string | null;
  bodyText?: string | null;
  subject?: string | null;
};

const urlPattern = /(https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+)/gi;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeUrl(value: string) {
  return value.startsWith("www.") ? `https://${value}` : value;
}

function sanitizeEmailHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[\s\S]*?>[\s\S]*?<\/embed>/gi, "")
    .replace(/<form[\s\S]*?>/gi, "<div>")
    .replace(/<\/form>/gi, "</div>")
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/href\s*=\s*(['"])\s*javascript:[\s\S]*?\1/gi, "href=\"#\"")
    .replace(/src\s*=\s*(['"])\s*javascript:[\s\S]*?\1/gi, "src=\"\"");
}

function emailSrcDoc(html: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <base target="_blank" />
  <style>
    html, body { margin: 0; min-height: 100%; background: #f8fafc; color: #111827; font-family: Arial, Helvetica, sans-serif; }
    body { padding: 24px; overflow-wrap: anywhere; }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; }
    a { color: #0f766e; }
    button, a[role="button"] { cursor: pointer; }
  </style>
</head>
<body>${sanitizeEmailHtml(html)}</body>
</html>`;
}

function PlainTextBody({ text }: { text: string }) {
  const parts = text.split(urlPattern);
  return (
    <div className="whitespace-pre-wrap rounded-md border border-panel-line bg-slate-50 p-6 text-sm leading-6 text-slate-700">
      {parts.map((part, index) => {
        if (part.match(urlPattern)) {
          const href = normalizeUrl(part);
          return (
            <a className="break-all font-medium text-panel-accent underline" href={href} key={`${part}-${index}`} rel="noopener noreferrer" target="_blank">
              {part}
            </a>
          );
        }
        return <Fragment key={`${part}-${index}`}>{part}</Fragment>;
      })}
    </div>
  );
}

export function MailMessageBody({ message }: { message: MessageBody }) {
  const html = message.bodyHtml?.trim();
  if (html) {
    return (
      <div className="overflow-hidden rounded-md border border-panel-line bg-slate-50">
        <iframe
          className="h-[620px] w-full bg-slate-50"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={emailSrcDoc(html)}
          title={message.subject ? `Message body: ${message.subject}` : "Message body"}
        />
      </div>
    );
  }

  return <PlainTextBody text={message.bodyText?.trim() || "No message body."} />;
}

export function messagePreview(message: MessageBody) {
  const text = message.bodyText || message.bodyHtml?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text || "No message body.";
}
