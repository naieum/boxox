import type { ReactNode } from "react";

export function PageContainer({
  children,
  width = 1080,
}: {
  children: ReactNode;
  width?: number;
}) {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-surface-1">
      <div className="mx-auto px-4 py-5 md:px-10 md:py-8" style={{ maxWidth: width }}>
        {children}
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-end justify-between gap-3.5">
      <div>
        <h1 className="mb-[5px] font-heading text-2xl font-extrabold tracking-[-0.02em]">
          {title}
        </h1>
        <p className="text-[13px] text-[#7C838F]">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`overflow-hidden rounded-[14px] border border-white/7 bg-surface-3 ${className}`}>
      {children}
    </div>
  );
}

export function PanelEmpty({
  title,
  desc,
  action,
}: {
  title: string;
  desc: string;
  action?: ReactNode;
}) {
  return (
    <Panel>
      <div className="flex flex-col items-center px-6 py-14 text-center">
        <div className="mb-1 font-heading text-[15.5px] font-bold">{title}</div>
        <div className="max-w-[300px] text-[12.5px] leading-[1.55] text-[#7C838F]">{desc}</div>
        {action && <div className="mt-[18px]">{action}</div>}
      </div>
    </Panel>
  );
}
