export function PageHeader({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <header className="flex min-h-14 flex-col gap-2 border-b border-panel-line bg-white/90 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 backdrop-blur-md">
      <div className="min-w-0">
        <h1 className="text-base font-semibold text-panel-ink sm:text-lg truncate">{title}</h1>
        {description ? <p className="text-xs text-panel-muted truncate hidden sm:block">{description}</p> : null}
      </div>
      {action ? <div className="flex flex-wrap items-center gap-2 sm:justify-end">{action}</div> : null}
    </header>
  );
}
