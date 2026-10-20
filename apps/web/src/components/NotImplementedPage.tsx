/**
 * Used for nav sections that don't have a real backend yet. Shows that
 * honestly instead of a page full of buttons that look functional but do
 * nothing — per the project's "no fake placeholder controls" rule.
 */
export function NotImplementedPage({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="rounded-lg border border-dashed border-slate-700 p-6 text-slate-400">
        <p className="font-medium text-slate-300">Not implemented yet.</p>
        <p className="mt-1 text-sm">{phase}</p>
      </div>
    </div>
  );
}
