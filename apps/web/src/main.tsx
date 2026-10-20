import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./AppShell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ComposePage } from "./pages/Compose";
import { DevKeysPage } from "./pages/DevKeys";
import { DevMessagesPage } from "./pages/DevMessages";
import { DevTemplatesPage } from "./pages/DevTemplates";
import { DevWebhooksPage } from "./pages/DevWebhooks";
import { DomainsPage } from "./pages/Domains";
import { MailPage } from "./pages/Mail";
import { SettingsPage } from "./pages/Settings";
import { SetupPage } from "./pages/Setup";
import type { ComposeMode } from "./lib/api";
import "./styles.css";

const COMPOSE_MODES: ComposeMode[] = ["new", "reply", "reply_all", "forward", "forward_eml"];

const rootRoute = createRootRoute({ component: Outlet });

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: AppShell,
});

const inboxRoute = createRoute({ getParentRoute: () => shellRoute, path: "/", component: MailPage });
const folderRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/folder/$folder",
  component: MailPage,
  validateSearch: (s: Record<string, unknown>): { q?: string } => ({ q: typeof s.q === "string" ? s.q : undefined }),
});
const addressRoute = createRoute({ getParentRoute: () => shellRoute, path: "/address/$addressId", component: MailPage });
const composeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/compose",
  component: ComposePage,
  // ?from=<addressId> pre-picks the From identity (set when composing from an address view);
  // ?draft=<id> reopens a draft; ?reply=<messageId>&mode= answers or forwards a message.
  validateSearch: (s: Record<string, unknown>): { from?: string; draft?: string; reply?: string; mode?: ComposeMode } => ({
    from: typeof s.from === "string" ? s.from : undefined,
    draft: typeof s.draft === "string" ? s.draft : undefined,
    reply: typeof s.reply === "string" ? s.reply : undefined,
    mode: COMPOSE_MODES.find((m) => m === s.mode),
  }),
});
const domainsRoute = createRoute({ getParentRoute: () => shellRoute, path: "/domains", component: DomainsPage,
  validateSearch: (s: Record<string, unknown>): { cloudflare?: "connected" | "denied" | "failed" } => ({ cloudflare: s.cloudflare === "connected" || s.cloudflare === "denied" || s.cloudflare === "failed" ? s.cloudflare : undefined }),
});
const devKeysRoute = createRoute({ getParentRoute: () => shellRoute, path: "/developer/keys", component: DevKeysPage });
const devMessagesRoute = createRoute({ getParentRoute: () => shellRoute, path: "/developer/messages", component: DevMessagesPage });
const devTemplatesRoute = createRoute({ getParentRoute: () => shellRoute, path: "/developer/templates", component: DevTemplatesPage });
const devWebhooksRoute = createRoute({ getParentRoute: () => shellRoute, path: "/developer/webhooks", component: DevWebhooksPage });
const settingsRoute = createRoute({ getParentRoute: () => shellRoute, path: "/settings", component: SettingsPage });
const setupRoute = createRoute({ getParentRoute: () => shellRoute, path: "/setup", component: SetupPage });

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    inboxRoute,
    folderRoute,
    addressRoute,
    composeRoute,
    domainsRoute,
    devKeysRoute,
    devMessagesRoute,
    devTemplatesRoute,
    devWebhooksRoute,
    settingsRoute,
    setupRoute,
  ]),
]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
