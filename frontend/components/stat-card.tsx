export function StatCard({ label, value, tone = "default" }: { label: string; value: string | number; tone?: "default" | "warn" | "danger" }) {
  const toneClass = tone === "danger" ? "text-panel-danger" : tone === "warn" ? "text-panel-warn" : "text-panel-accent";
  return (
    <div className="rounded-md border border-panel-line bg-white/95 p-4 shadow-sm">
      <div className="text-xs font-semibold text-panel-muted">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
