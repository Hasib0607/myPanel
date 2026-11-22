"use client";

import { FormEvent, useEffect, useState } from "react";
import { X } from "lucide-react";

type InputModalProps = {
  open: boolean;
  title: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  pending?: boolean;
  onConfirm: (value: string) => void;
  onClose: () => void;
};

export function InputModal({
  open,
  title,
  label,
  placeholder,
  defaultValue = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  pending = false,
  onConfirm,
  onClose
}: InputModalProps) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    if (!open) return;
    setValue(defaultValue);
  }, [defaultValue, open]);

  if (!open) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onConfirm(value);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="input-modal-title">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-panel-line bg-white shadow-2xl transition-all">
        <div className="flex items-start justify-between border-b border-panel-line p-4 sm:p-5">
          <h2 className="text-base font-semibold text-panel-ink" id="input-modal-title">{title}</h2>
          <button className="grid h-8 w-8 place-items-center rounded-lg border border-panel-line text-panel-muted hover:bg-slate-50 transition-colors" onClick={onClose} type="button" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="space-y-2 p-4 sm:p-5">
            {label ? <label className="block text-sm font-medium text-panel-muted">{label}</label> : null}
            <input
              autoFocus
              className="h-10 w-full rounded-lg border border-panel-line px-3 text-sm focus:border-panel-accent focus:ring-1 focus:ring-panel-accent outline-none"
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder}
              value={value}
            />
          </div>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 bg-slate-50/80 px-4 py-4 sm:px-5">
            <button className="flex h-10 items-center justify-center rounded-lg border border-panel-line bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 transition-colors" disabled={pending} onClick={onClose} type="button">
              {cancelLabel}
            </button>
            <button className="flex h-10 items-center justify-center rounded-lg bg-panel-accent px-4 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60 transition-colors" disabled={pending} type="submit">
              {pending ? "Working..." : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
