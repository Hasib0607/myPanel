export function PageHeader({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  if (!action) return null;

  return (
    <header className="flex min-h-16 items-center justify-end border-b border-panel-line bg-white/85 px-6 py-3 backdrop-blur">
      <span className="sr-only">{title}: {description}</span>
      <div className="flex flex-wrap items-center justify-end gap-2">{action}</div>
    </header>
  );
}
