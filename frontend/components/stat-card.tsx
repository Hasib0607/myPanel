export function StatCard({ label, value, tone = "default" }: { label: string; value: string | number; tone?: "default" | "warn" | "danger" }) {
  const toneClass = tone === "danger" ? "text-panel-danger" : tone === "warn" ? "text-panel-warn" : "text-panel-accent";
  return (
    <div className="rounded-lg sm:rounded-xl border border-panel-line bg-white/95 p-3.5 sm:p-4 shadow-sm transition-all hover:shadow">
      <div className="text-xs font-semibold uppercase tracking-wider text-panel-muted truncate">{label}</div>
      <div className={`mt-1.5 text-xl sm:text-2xl font-bold tracking-tight ${toneClass} truncate`}>{value}</div>
    </div>
  );
}
