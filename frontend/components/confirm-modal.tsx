"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

type ConfirmModalProps = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  pending?: boolean;
  tone?: "danger" | "warn";
  checkboxLabel?: string;
  checkboxDefaultChecked?: boolean;
  onConfirm: (checked?: boolean) => void;
  onClose: () => void;
};

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  pending = false,
  tone = "danger",
  checkboxLabel,
  checkboxDefaultChecked = false,
  onConfirm,
  onClose
}: ConfirmModalProps) {
  const [checked, setChecked] = useState(checkboxDefaultChecked);

  useEffect(() => {
    if (!open) return;
    setChecked(checkboxDefaultChecked);
  }, [open, checkboxDefaultChecked]);

  if (!open) return null;

  const toneClass = tone === "danger" ? "bg-red-600 hover:bg-red-700 active:bg-red-800" : "bg-amber-600 hover:bg-amber-700 active:bg-amber-800";
  const iconClass = tone === "danger" ? "bg-red-50 text-panel-danger" : "bg-amber-50 text-panel-warn";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-panel-line bg-white shadow-2xl transition-all">
        <div className="flex items-start gap-3 border-b border-panel-line p-4 sm:p-5">
          <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${iconClass}`}>
            <AlertTriangle size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-panel-ink" id="confirm-modal-title">{title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-panel-muted break-words">{message}</p>
          </div>
          <button className="grid h-8 w-8 place-items-center rounded-lg border border-panel-line text-panel-muted hover:bg-slate-50 transition-colors" onClick={onClose} type="button" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-4 bg-slate-50/80 px-4 py-4 sm:px-5">
          {checkboxLabel ? (
            <label className="flex items-center gap-2.5 text-sm text-panel-ink cursor-pointer">
              <input
                checked={checked}
                className="h-4 w-4 rounded border-panel-line text-panel-accent focus:ring-panel-accent"
                disabled={pending}
                onChange={(event) => setChecked(event.target.checked)}
                type="checkbox"
              />
              <span className="select-none">{checkboxLabel}</span>
            </label>
          ) : null}
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button className="flex h-10 items-center justify-center rounded-lg border border-panel-line bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 transition-colors" disabled={pending} onClick={onClose} type="button">
              {cancelLabel}
            </button>
            <button className={`flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold text-white shadow-sm disabled:opacity-60 transition-colors ${toneClass}`} disabled={pending} onClick={() => onConfirm(checked)} type="button">
              {pending ? "Working..." : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
