export function PageHeader({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <header className="flex items-center justify-between border-b border-panel-line bg-white px-8 py-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal">{title}</h1>
        <p className="mt-1 text-sm text-panel-muted">{description}</p>
      </div>
      {action}
    </header>
  );
}
