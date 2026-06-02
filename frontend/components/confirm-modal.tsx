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

  const toneClass = tone === "danger" ? "bg-red-600 hover:bg-red-700" : "bg-amber-600 hover:bg-amber-700";
  const iconClass = tone === "danger" ? "bg-red-50 text-panel-danger" : "bg-amber-50 text-panel-warn";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title">
      <div className="w-full max-w-md overflow-hidden rounded-md border border-panel-line bg-white shadow-2xl">
        <div className="flex items-start gap-3 border-b border-panel-line p-5">
          <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-md ${iconClass}`}>
            <AlertTriangle size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold" id="confirm-modal-title">{title}</h2>
            <p className="mt-1 text-sm leading-6 text-panel-muted">{message}</p>
          </div>
          <button className="grid h-8 w-8 place-items-center rounded-md border border-panel-line text-panel-muted hover:bg-slate-50" onClick={onClose} type="button" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3 bg-slate-50 px-5 py-4">
          {checkboxLabel ? (
            <label className="flex items-center gap-2 text-sm text-panel-text">
              <input
                checked={checked}
                className="h-4 w-4 rounded border-panel-line"
                disabled={pending}
                onChange={(event) => setChecked(event.target.checked)}
                type="checkbox"
              />
              <span>{checkboxLabel}</span>
            </label>
          ) : null}
          <div className="flex justify-end gap-2">
            <button className="h-10 rounded-md border border-panel-line bg-white px-4 text-sm font-semibold hover:bg-slate-100" disabled={pending} onClick={onClose} type="button">
              {cancelLabel}
            </button>
            <button className={`h-10 rounded-md px-4 text-sm font-semibold text-white disabled:opacity-60 ${toneClass}`} disabled={pending} onClick={() => onConfirm(checked)} type="button">
              {pending ? "Working..." : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
