import { categoryLabel } from "./categories";

const PRIORITIES = ["Low priority", "Normal priority", "High priority", "Highest priority"];

export function ClassificationBadges({ priority, category, compact = false }: { priority?: number | null; category?: string | null; compact?: boolean }) {
  return <>
    {typeof priority === "number" && PRIORITIES[priority] && (!compact || priority >= 2) &&
      <span className="rounded-[5px] bg-ox/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-ox">{PRIORITIES[priority]}</span>}
    {category && <span className="rounded-[5px] bg-white/6 px-1.5 py-0.5 text-[10.5px] text-[#C4CAD4]">{categoryLabel(category)}</span>}
  </>;
}
