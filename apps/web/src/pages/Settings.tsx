import { Bell, Droplet, LogOut, ShieldCheck, User } from "lucide-react";
import { useState } from "react";
import { useMe } from "@/AppShell";
import { initialsOf } from "@/components/brand";
import { PageContainer, PageHeader, Panel } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { ProcessingSettingsTab } from "./ProcessingSettings";

const TABS = [
  { id: "profile", label: "Profile", icon: User },
  { id: "processing", label: "Processing", icon: ShieldCheck },
  { id: "appearance", label: "Appearance", icon: Droplet },
  { id: "notifications", label: "Notifications", icon: Bell },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Deep-links (`?tab=notifications`) land on the right tab without a route per tab. */
function initialTab(): TabId {
  const t = new URLSearchParams(window.location.search).get("tab");
  if (TABS.some((x) => x.id === t)) return t as TabId;
  return "profile";
}

function ProfileTab() {
  const me = useMe();
  const user = me.data?.user;
  if (!user) return null;
  return (
    <div className="flex flex-col gap-[22px]">
      <div className="flex items-center gap-4">
        <div className="flex size-16 items-center justify-center rounded-full bg-ox-cream font-heading text-[22px] font-bold text-ox-navy">
          {initialsOf(user.name || user.email)}
        </div>
        <div className="text-[12.5px] text-[#7c838f]">
          Your identity comes from Cloudflare Access.
        </div>
      </div>
      <div className="space-y-[7px]">
        <Label className="text-xs font-medium text-[#9BA1AD]">Email</Label>
        <div className="flex h-[42px] items-center gap-2.5 rounded-[10px] border border-white/10 bg-white/2 px-3.5">
          <span className="flex-1 text-sm text-[#C4CAD4]">{user.email}</span>
          <Badge className="rounded-full text-[11px] font-semibold capitalize">{user.role}</Badge>
        </div>
      </div>
    </div>
  );
}

function AppearanceTab() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mb-1 text-sm font-semibold">Theme</div>
        <div className="mb-3 text-xs text-[#7c838f]">Box Ox is dark by default. Light theme is on the roadmap.</div>
        <div className="inline-flex gap-0.5 rounded-[11px] bg-white/5 p-[3px]">
          <span className="rounded-lg bg-white/12 px-4 py-[7px] text-[13px] font-semibold">Dark</span>
          <span className="cursor-not-allowed px-4 py-[7px] text-[13px] font-medium text-[#9BA1AD]/50">Light</span>
          <span className="cursor-not-allowed px-4 py-[7px] text-[13px] font-medium text-[#9BA1AD]/50">System</span>
        </div>
      </div>
      <div>
        <div className="mb-3 text-sm font-semibold">Accent color</div>
        <div className="flex gap-3">
          <span className="size-[34px] cursor-pointer rounded-full bg-ox shadow-[0_0_0_2px_#0a0c10,0_0_0_4px_#F26B2C]" />
          <span className="size-[34px] rounded-full bg-ox-info opacity-40" title="Coming soon" />
          <span className="size-[34px] rounded-full bg-ox-success opacity-40" title="Coming soon" />
          <span className="size-[34px] rounded-full bg-ox-purple opacity-40" title="Coming soon" />
        </div>
      </div>
    </div>
  );
}

const NOTIF_ITEMS = [
  { id: "mail", label: "New mail", desc: "A message arrives in a mailbox you follow." },
  { id: "mentions", label: "Agent activity", desc: "An agent replies, drafts or assigns a thread to you." },
  { id: "failures", label: "Delivery failures", desc: "Bounces and failed sends on your domains." },
  { id: "reports", label: "Weekly reports", desc: "Deliverability and engagement summary." },
  { id: "digest", label: "Daily digest", desc: "One morning email instead of many pings." },
] as const;

const NOTIF_DEFAULTS: Record<string, boolean> = {
  mail: true,
  mentions: true,
  failures: true,
  reports: true,
  digest: false,
};

function NotificationsTab() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2.5 rounded-xl border border-white/7 bg-white/2 px-[18px] py-3 text-[12.5px] text-[#9BA1AD]">
        <Badge className="rounded-full bg-white/5 text-[11px] font-semibold text-[#9BA1AD]">Coming soon</Badge>
        These defaults show what you'll be able to tune once notification delivery ships.
      </div>
      <Panel>
        {NOTIF_ITEMS.map((n, i) => (
          <div
            key={n.id}
            className={`flex items-center gap-4 px-5 py-4 ${i < NOTIF_ITEMS.length - 1 ? "border-b border-white/4" : ""}`}
          >
            <div className="flex-1">
              <div className="text-[13.5px] font-medium">{n.label}</div>
              <div className="mt-0.5 text-xs text-[#7c838f]">{n.desc}</div>
            </div>
            <Switch checked={NOTIF_DEFAULTS[n.id]} disabled aria-label={n.label} />
          </div>
        ))}
      </Panel>
    </div>
  );
}

export function SettingsPage() {
  const [tab, setTab] = useState<TabId>(initialTab);
  const isOwner = useMe().data?.user.role === "owner";

  return (
    <PageContainer width={1000}>
      <PageHeader title="Settings" description="Manage your profile and preferences." />
      <div className="flex flex-col gap-8 md:flex-row">
        <div className="flex flex-row gap-1 overflow-x-auto md:w-[190px] md:flex-none md:flex-col">
          {TABS.filter((t) => t.id !== "processing" || isOwner).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-[9px] rounded-[9px] px-3 py-[9px] text-left text-[13px] font-medium whitespace-nowrap ${
                tab === t.id ? "bg-white/7 text-foreground" : "text-[#C4CAD4] hover:bg-white/4"
              }`}
            >
              <t.icon className="size-4" strokeWidth={1.6} />
              {t.label}
            </button>
          ))}
        </div>
        <div className="min-w-0 max-w-[640px] flex-1">
          {tab === "profile" && <ProfileTab />}
          {tab === "processing" && (isOwner ? <ProcessingSettingsTab /> : <p>Only the owner can change mail processing.</p>)}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "notifications" && <NotificationsTab />}
        </div>
      </div>
      <div className="mt-[34px] border-t border-white/7 pt-5">
        <Button
          variant="outline"
          onClick={() => {
            window.location.href = "/cdn-cgi/access/logout";
          }}
          className="h-[38px] gap-[9px] rounded-[10px] border-white/12 bg-transparent px-4 text-[13px] font-medium text-[#C4CAD4]"
        >
          <LogOut className="size-[17px]" strokeWidth={1.6} /> Sign out
        </Button>
      </div>
    </PageContainer>
  );
}
