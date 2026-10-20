import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  AlarmClock,
  ArrowUp,
  Archive,
  MailQuestion,
  Clock,
  FileText,
  Globe,
  Inbox as InboxIcon,
  KeyRound,
  Menu,
  PenLine,
  Search,
  Send,
  ShieldAlert,
  SlidersVertical,
  Star,
  Trash2,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { initialsOf, OxMark, Wordmark } from "@/components/brand";
import { api } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ORG_ID } from "./config";
import { MAIL_CATEGORIES, categoryLabel } from "./components/conversation/categories";

function FullScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 p-6">
      {children}
    </div>
  );
}

const MAIL_NAV = [
  { to: "/", label: "Inbox", icon: InboxIcon, badge: undefined as string | undefined },
  { to: "/folder/priority", label: "Priority inbox", icon: ArrowUp },
  { to: "/folder/starred", label: "Starred", icon: Star },
  { to: "/folder/snoozed", label: "Snoozed", icon: AlarmClock },
  { to: "/folder/sent", label: "Sent", icon: Send },
  { to: "/folder/drafts", label: "Drafts", icon: FileText },
  { to: "/folder/scheduled", label: "Scheduled", icon: Clock },
  { to: "/folder/archive", label: "Archive", icon: Archive },
  { to: "/folder/spam", label: "Spam", icon: ShieldAlert },
  { to: "/folder/trash", label: "Trash", icon: Trash2 },
];

const UNROUTED_NAV = { to: "/folder/unrouted", label: "Unrouted", icon: MailQuestion };

const ADMIN_NAV = [
  { to: "/domains", label: "Domains", icon: Globe, section: "/domains" },
  { to: "/developer/keys", label: "Developer", icon: KeyRound, section: "/developer/" },
];

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pt-4 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[#767d8a]">
      {children}
    </div>
  );
}

function NavItem({
  to,
  label,
  icon: Icon,
  active,
  badge,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: typeof InboxIcon;
  active: boolean;
  badge?: string;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      className={`flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-[13px] font-medium transition-colors ${
        active ? "bg-white/7 text-foreground" : "text-[#C4CAD4] hover:bg-white/4"
      }`}
    >
      <Icon className="size-[17px] text-[#C7CCD6]" strokeWidth={1.6} />
      <span className="flex-1">{label}</span>
      {badge && (
        <span className="rounded-full bg-ox px-[7px] py-px text-center text-[11px] font-semibold text-white">
          {badge}
        </span>
      )}
    </Link>
  );
}

const KIND_DOT: Record<string, string> = {
  personal: "#35C07A",
  role: "#3DA5F4",
  agent: "#F26B2C",
  disposable: "#A78BFA",
};

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const orgId = useActiveOrgId();
  const me = useMe();
  const addresses = useQuery({
    queryKey: ["addresses", orgId],
    queryFn: () => api.addresses.list(orgId),
    enabled: !!orgId,
    refetchInterval: 30_000,
  });
  const domainHealth = useQuery({
    queryKey: ["domains", orgId], queryFn: () => api.domains.list(orgId),
    enabled: !!orgId && me.data?.user.role === "owner", refetchInterval: 60_000,
  });
  const domainProblems = domainHealth.data?.domains.filter(d => d.active && d.health
    && (!d.health.healthy || (d.health.reputation?.status === "listed" || d.health.reputation?.lastKnown === "listed"))).length ?? 0;
  const rows = (addresses.data?.addresses ?? []).filter((a) => a.status !== "archived");
  const totalUnread = rows.reduce((n, a) => n + a.unread, 0);
  const unroutedCount = addresses.data?.unroutedCount ?? 0;

  // Group by domain (rows arrive sorted domain-then-localpart from the API), so
  // rows can show just the local part — the domain header disambiguates
  // hello@domain-a from hello@domain-b instead of truncation hiding the domain.
  const groups: { domain: string; items: typeof rows }[] = [];
  for (const a of rows) {
    const last = groups[groups.length - 1];
    if (last && last.domain === a.domainName) last.items.push(a);
    else groups.push({ domain: a.domainName, items: [a] });
  }

  // Invited people (attached via address grants) get mail, not install
  // management — hide the Manage section for them.
  const role = me.data?.user.role;
  const isOrgAdmin = role === "owner" || role === "admin";

  return (
    <>
      <SectionLabel>Mail</SectionLabel>
      <div className="flex flex-col gap-px">
        {MAIL_NAV.map((n) => (
          <NavItem
            key={n.to}
            {...n}
            badge={
              n.to === "/" && totalUnread > 0
                ? totalUnread > 99
                  ? "99+"
                  : String(totalUnread)
                : undefined
            }
            active={pathname === n.to}
            onNavigate={onNavigate}
          />
        ))}
        {unroutedCount > 0 && (
          <NavItem
            {...UNROUTED_NAV}
            badge={String(unroutedCount)}
            active={pathname === UNROUTED_NAV.to}
            onNavigate={onNavigate}
          />
        )}
      </div>
      <SectionLabel>Categories</SectionLabel>
      <select
        aria-label="Mail category"
        value={pathname.startsWith("/folder/category-") ? pathname.slice("/folder/category-".length) : ""}
        onChange={(event) => {
          if (event.target.value) {
            navigate({ to: "/folder/$folder", params: { folder: `category-${event.target.value}` } });
            onNavigate?.();
          }
        }}
        className="mx-2 mb-1 w-[calc(100%-16px)] rounded-lg border border-white/10 bg-surface-2 px-2 py-2 text-[12.5px] text-[#C4CAD4]"
      >
        <option value="" disabled>Choose a category</option>
        {MAIL_CATEGORIES.map((category) => <option key={category} value={category}>{categoryLabel(category)}</option>)}
      </select>
      <SectionLabel>Addresses</SectionLabel>
      <div className="flex flex-col gap-px">
        {rows.length === 0 && (
          <Link
            to="/domains"
            onClick={onNavigate}
            className="rounded-[9px] px-2.5 py-1 text-xs text-[#7c838f] hover:bg-white/4"
          >
            No addresses yet — create one under Domains.
          </Link>
        )}
        {groups.map((g) => (
          <div key={g.domain}>
            <div className="truncate px-2.5 pt-2 pb-0.5 font-mono text-[10px] tracking-[0.02em] text-[#767d8a]">
              @{g.domain}
            </div>
            {g.items.map((a) => (
              <Link
                key={a.id}
                to="/address/$addressId"
                params={{ addressId: a.id }}
                onClick={onNavigate}
                title={a.email}
                className={`flex items-center gap-2.5 rounded-[9px] px-2.5 py-[7px] text-[12.5px] ${
                  pathname === `/address/${a.id}`
                    ? "bg-white/7 text-foreground"
                    : "text-[#C4CAD4] hover:bg-white/4"
                }`}
              >
                <span
                  className="size-[7px] flex-none rounded-full"
                  style={{ background: KIND_DOT[a.kind] }}
                />
                <span className="min-w-0 flex-1 truncate">{a.localPart}</span>
                {a.kind === "agent" && (
                  <span className="rounded-[4px] bg-ox/12 px-[5px] py-px text-[9.5px] font-bold tracking-[0.04em] text-ox">
                    AI
                  </span>
                )}
                {a.unread > 0 && <span className="text-[11px] text-[#7C838F]">{a.unread}</span>}
              </Link>
            ))}
          </div>
        ))}
      </div>
      {isOrgAdmin && (
        <>
          <SectionLabel>Manage</SectionLabel>
          <div className="flex flex-col gap-px">
            {ADMIN_NAV.map(({ section, ...n }) => (
              <NavItem key={n.to} {...n} badge={n.to === "/domains" && domainProblems ? String(domainProblems) : undefined} active={pathname.startsWith(section)} onNavigate={onNavigate} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

export function AppShell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMe();
  useRealtime(me.data ? ORG_ID : undefined);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Composing while viewing an address should send from that address.
  const addressMatch = pathname.match(/^\/address\/([^/]+)$/);
  const composeFrom = addressMatch?.[1];
  const openCompose = () => {
    if (me.data?.capabilities?.sending === false) return;
    navigate({ to: "/compose", search: { from: composeFrom } });
  };

  if (me.isPending) {
    return (
      <FullScreen>
        <OxMark />
      </FullScreen>
    );
  }

  if (!me.data) {
    // The Worker fails closed until Cloudflare Access is set up (README checklist).
    return (
      <FullScreen>
        <div className="w-full max-w-[392px]">
          <div className="mb-[30px] flex items-center gap-[11px]">
            <OxMark />
            <Wordmark />
          </div>
          <h1 className="mb-1.5 font-heading text-2xl font-bold tracking-[-0.02em]">
            Protect Box Ox with Cloudflare Access
          </h1>
          <p className="text-[13.5px] text-[#7C838F]">
            This install refuses every request until an Access application covers it and
            ACCESS_AUD and TEAM_DOMAIN are set. Follow the post-deploy checklist in the README.
          </p>
        </div>
      </FullScreen>
    );
  }

  const user = me.data.user;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-surface-0">
      <a
        href="#main"
        className="sr-only left-3 top-3 z-50 rounded-lg bg-ox px-3 py-2 text-[13px] font-semibold text-white focus:not-sr-only focus:absolute"
      >
        Skip to content
      </a>
      {/* Sidebar (desktop) */}
      <aside className="hidden w-60 flex-none flex-col border-r border-white/6 bg-surface-1 md:flex">
        <div className="flex h-14 flex-none items-center gap-1.5 border-b border-white/6 px-2.5">
          <Link
            to="/"
            title="Box Ox — go to Inbox"
            className="flex-none rounded-lg p-0.5 hover:bg-white/5"
          >
            <OxMark size={28} icon={15} radius={8} />
          </Link>
          <Wordmark className="text-[15px]" />
        </div>
        <div className="flex-none px-3 pt-3 pb-1.5">
          <Button
            variant="outline"
            onClick={openCompose}
            disabled={me.data?.capabilities?.sending === false}
            title={me.data?.capabilities?.sending === false ? "Sending requires the Paid profile. Upgrade Cloudflare Workers and rerun the installer." : undefined}
            className="h-[38px] w-full justify-start gap-[9px] rounded-[10px] border-white/12 bg-white/4 text-[13px] font-medium hover:bg-white/8"
          >
            <PenLine className="size-[15px] text-[#9BA1AD]" strokeWidth={1.7} />
            {me.data?.capabilities?.sending === false ? "Receiving only" : "Compose"}
            <span className="flex-1" />
            <span className="font-mono text-[10.5px] text-[#767d8a]">C</span>
          </Button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2.5 pb-3">
          <SidebarNav />
        </nav>
        <div className="flex flex-none items-center gap-2.5 border-t border-white/6 px-3 py-2.5">
          <button
            onClick={() => navigate({ to: "/settings" })}
            className="flex size-8 flex-none items-center justify-center rounded-full bg-ox-cream font-heading text-xs font-bold text-ox-navy"
          >
            {initialsOf(user.name || user.email)}
          </button>
          <div className="min-w-0 flex-1 leading-[1.2]">
            <div className="truncate text-[12.5px] font-semibold">{user.name}</div>
            <div className="truncate text-[11px] text-[#7C838F]">{user.email}</div>
          </div>
          <Link
            to="/settings"
            title="Settings"
            className="flex size-8 flex-none items-center justify-center rounded-lg text-[#9BA1AD] hover:bg-white/5 hover:text-foreground"
          >
            <SlidersVertical className="size-[17px]" strokeWidth={1.6} />
          </Link>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative z-40 flex h-14 flex-none items-center gap-3 border-b border-white/6 bg-[rgba(12,14,18,0.7)] px-4 backdrop-blur-xl">
          {/* Mobile drawer */}
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger className="flex size-[38px] items-center justify-center rounded-[10px] text-foreground hover:bg-white/5 md:hidden">
              <Menu className="size-5" strokeWidth={1.8} />
            </SheetTrigger>
            <SheetContent side="left" className="w-[282px] border-white/8 bg-surface-3 p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="flex items-center gap-[11px] border-b border-white/6 p-4">
                <OxMark size={34} icon={18} radius={10} />
                <Wordmark className="text-[17px]" />
              </div>
              <nav className="flex-1 overflow-y-auto px-3 pb-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    setDrawerOpen(false);
                    openCompose();
                  }}
                  className="mt-3 h-10 w-full justify-start gap-[9px] rounded-[11px] border-white/12 bg-white/4 text-[13.5px]"
                >
                  <PenLine className="size-4 text-[#9BA1AD]" strokeWidth={1.7} />
                  {me.data?.capabilities?.sending === false ? "Receiving only" : "Compose"}
                </Button>
                <SidebarNav onNavigate={() => setDrawerOpen(false)} />
              </nav>
            </SheetContent>
          </Sheet>

          <form className="relative max-w-[560px] flex-1" role="search" onSubmit={(event) => {
            event.preventDefault();
            const query = new FormData(event.currentTarget).get("q")?.toString().trim();
            if (query) {
              queryClient.invalidateQueries({ queryKey: ["mail-search", ORG_ID, query] });
              navigate({ to: "/folder/$folder", params: { folder: "search" }, search: { q: query } });
            }
          }}>
            <label htmlFor="global-search" className="sr-only">
              Search mail
            </label>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[#7c838f]" strokeWidth={1.7} />
            <Input
              id="global-search"
              name="q"
              type="search"
              placeholder="Search mail"
              className="h-9 rounded-[10px] border-white/7 bg-white/3 pr-16 pl-9 text-[13px]"
            />
            <button type="submit" className="absolute top-1/2 right-2 -translate-y-1/2 rounded bg-white/6 px-2 py-1 text-[11px] font-semibold text-[#C4CAD4] hover:bg-white/12">Search</button>
          </form>
          <div className="flex-1" />
        </header>

        <main id="main" className="flex min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function useActiveOrgId(): string {
  return ORG_ID;
}

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api.me(), retry: false });
}
