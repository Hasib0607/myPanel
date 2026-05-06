export function StatCard({ label, value, tone = "default" }: { label: string; value: string | number; tone?: "default" | "warn" | "danger" }) {
  const toneClass = tone === "danger" ? "text-panel-danger" : tone === "warn" ? "text-panel-warn" : "text-panel-accent";
  return (
    <div className="rounded-md border border-panel-line bg-white p-4">
      <div className="text-xs font-medium uppercase text-panel-muted">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
