/** Box Ox mark from the design: envelope with orange notification dot on navy chip. */
export function OxMark({
  size = 42,
  icon = 22,
  radius = 12,
}: {
  size?: number;
  icon?: number;
  radius?: number;
}) {
  return (
    <div
      className="flex items-center justify-center bg-ox-navy shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <svg width={icon} height={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="3" y="5.5" width="18" height="13" rx="2.2" stroke="#F4E9D6" strokeWidth="1.7" />
        <path d="M4 7l8 6 8-6" stroke="#F4E9D6" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="18.5" cy="6" r="2.4" fill="#F26B2C" />
      </svg>
    </div>
  );
}

export function Wordmark({ className = "text-[22px]" }: { className?: string }) {
  return (
    <span className={`font-heading font-extrabold tracking-[-0.01em] ${className}`}>
      BOX OX
    </span>
  );
}

/** Where users reach a human — used by password recovery and account deletion. */
export const SUPPORT_EMAIL = "support@boxox.dev";

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}
