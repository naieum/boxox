import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { OxMark, Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

/** Only ever return to a path on this app. */
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/** A browser cancel is not an error worth showing as one. */
function reason(error: unknown): string {
  const e = error as { name?: string; message?: string };
  if (e?.name === "NotAllowedError" || e?.name === "AbortError") return "Nothing was saved. Try again when you are ready.";
  if (e?.name === "InvalidStateError") return "This device already has a passkey for this account. Sign in with it instead.";
  return e?.message ?? "Something went wrong. Try again.";
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-5 py-10 text-foreground">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 flex items-center gap-3">
          <OxMark />
          <Wordmark />
        </div>
        <h1 className="mb-2 font-heading text-[22px] font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

const supported = () => typeof window.PublicKeyCredential === "function";
const NO_PASSKEYS = "This browser cannot use passkeys. Use a current version of Chrome, Edge, Firefox or Safari.";

export function SignInPage() {
  const state = useQuery({ queryKey: ["auth", "state"], queryFn: () => api.auth.state(), retry: false });
  const login = useMutation({
    mutationFn: async () => {
      const { options } = await api.auth.loginBegin();
      await api.auth.loginFinish(await startAuthentication({ optionsJSON: options }));
    },
    onSuccess: () => window.location.replace(nextPath()),
  });
  if (state.data?.user || state.data?.mode === "access") {
    window.location.replace(nextPath());
    return null;
  }
  const ownerReady = state.data?.ownerReady !== false;
  return (
    <Frame title="Sign in">
      {ownerReady ? (
        <>
          <p className="mb-6 text-sm text-[#9BA1AD]">Use the passkey you saved for this Box Ox.</p>
          <Button className="h-11 w-full gap-2" disabled={login.isPending || !supported()} onClick={() => login.mutate()}>
            <KeyRound className="size-4" /> {login.isPending ? "Waiting for your passkey…" : "Sign in with a passkey"}
          </Button>
          {!supported() && <p role="alert" className="mt-4 text-sm text-ox-danger">{NO_PASSKEYS}</p>}
          {login.error && <p role="alert" className="mt-4 text-sm text-ox-danger">{reason(login.error)}</p>}
          <p className="mt-6 text-xs text-[#7c838f]">
            Lost your passkey? The owner can get a new sign-in link by running <code>pnpm run owner-link</code> where Box Ox was installed. Members ask the owner for a new link.
          </p>
        </>
      ) : (
        <p className="text-sm text-[#9BA1AD]">
          This Box Ox has no owner yet. Open the sign-in link the installer printed. To get a new one, run <code>pnpm run owner-link</code> where Box Ox was installed.
        </p>
      )}
    </Frame>
  );
}

/** /welcome#<code>: the single-use link from the installer or the owner. */
export function WelcomePage() {
  const code = window.location.hash.slice(1);
  const [device, setDevice] = useState("");
  const [invite, setInvite] = useState<{ email: string; role: string } | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      // The link is checked and the passkey requested in one step, so the code is sent once.
      const started = await api.auth.inviteBegin(code);
      setInvite({ email: started.email, role: started.role });
      await api.auth.inviteFinish(await startRegistration({ optionsJSON: started.options }), device);
    },
    onSuccess: () => window.location.replace(invite?.role === "owner" ? "/setup" : "/"),
  });
  if (!code) return <Frame title="This link is incomplete"><p className="text-sm text-[#9BA1AD]">Open the whole link, including everything after the # sign.</p></Frame>;
  return (
    <Frame title="Create your passkey">
      <p className="mb-6 text-sm text-[#9BA1AD]">
        A passkey signs you in to this Box Ox with your fingerprint, face or device PIN. There is no password. This link works once.
      </p>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
        <div className="space-y-1.5">
          <Label htmlFor="device" className="text-xs text-[#9BA1AD]">Name for this device (optional)</Label>
          <Input id="device" value={device} maxLength={80} placeholder="For example: Work laptop" onChange={(event) => setDevice(event.target.value)} />
        </div>
        <Button type="submit" className="h-11 w-full gap-2" disabled={create.isPending || !supported()}>
          <KeyRound className="size-4" /> {create.isPending ? "Waiting for your device…" : "Create passkey"}
        </Button>
      </form>
      {invite && create.isPending && <p className="mt-4 text-sm text-[#9BA1AD]">Creating a passkey for {invite.email}.</p>}
      {!supported() && <p role="alert" className="mt-4 text-sm text-ox-danger">{NO_PASSKEYS}</p>}
      {create.error && <p role="alert" className="mt-4 text-sm text-ox-danger">{reason(create.error)}</p>}
    </Frame>
  );
}
