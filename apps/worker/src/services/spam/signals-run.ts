import { eq } from "drizzle-orm";
import type { Email } from "postal-mime";
import { aiSettings } from "@boxox/db";
import type { Db } from "../../db";
import type { Env } from "../../env";
import { fingerprintSignal, fingerprintText, findSpamFingerprint, simhash } from "./fingerprint";
import { localSignals, linkDomains, sumWeights, type AuthSummary, type Signal, type SignalContext, type SignalMail } from "./signals";
import { checkSecureResolver, checkSpamhaus, loadOpenPhish, matchOpenPhish, MAX_LOOKUP_DOMAINS, type Fetcher } from "./signals-lookup";

export interface Layer1Result {
  /** False when the owner hasn't turned local filters on; nothing else ran. */
  ran: boolean;
  lookups: boolean;
  auth: AuthSummary | null;
  signals: Signal[];
  /** Sum of signal weights; the combiner's "rule score" input. */
  score: number;
  fingerprint: string | null;
  linkDomains: string[];
  errors: string[];
}

/** postal-mime's parse → the fields the rules read. */
export function signalMailFrom(email: Email): SignalMail {
  const from = Array.isArray(email.from) ? email.from[0] : email.from;
  const replyTo = (email.replyTo ?? []).flatMap((a) => (a.group ? a.group : [a])).map((a) => (a.address ?? "").toLowerCase()).filter((a) => a.includes("@"));
  return {
    headers: email.headers,
    fromEmail: (from && !from.group ? from.address ?? "" : "").toLowerCase(),
    fromName: from?.name?.trim() || null,
    replyTo,
    rfcMessageId: email.messageId ?? null,
    date: email.date ?? null,
    text: email.text ?? null,
    html: email.html ?? null,
    attachments: email.attachments.map((a) => ({
      filename: a.filename ?? "",
      contentType: a.mimeType,
      content: typeof a.content === "string" ? undefined : a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content),
    })),
  };
}

/**
 * Layer 1 for one message, honouring the owner's processing choices: local
 * rules and fingerprints need "local filters" on; 1.1.1.2, OpenPhish and
 * Spamhaus also need "reputation lookups" on. Lookup failures are recorded
 * in `errors` and never block delivery.
 */
export async function collectSignals(
  env: Pick<Env, "DB" | "KV" | "SPAMHAUS_DQS_KEY">,
  db: Db,
  mail: SignalMail,
  ctx: SignalContext,
  fetcher: Fetcher = fetch,
): Promise<Layer1Result> {
  const settings = await db.query.aiSettings.findFirst({ where: eq(aiSettings.id, 1) });
  if (settings?.localFilters !== true) {
    return { ran: false, lookups: false, auth: null, signals: [], score: 0, fingerprint: null, linkDomains: [], errors: [] };
  }
  const local = localSignals(mail, ctx);
  const signals = [...local.signals];
  const errors: string[] = [];

  const fingerprint = simhash(fingerprintText(mail));
  if (fingerprint) signals.push(...fingerprintSignal(await findSpamFingerprint(db, fingerprint)));

  const domains = linkDomains(local.links, ctx.ownerDomains, MAX_LOOKUP_DOMAINS);
  const lookups = settings.reputationLookups === true;
  if (lookups) {
    const [secure, feed, spamhaus] = await Promise.all([
      checkSecureResolver(domains, fetcher),
      loadOpenPhish(env.KV).catch(() => {
        errors.push("openphish:kv");
        return new Set<string>();
      }),
      env.SPAMHAUS_DQS_KEY ? checkSpamhaus({ key: env.SPAMHAUS_DQS_KEY, ip: local.sendingIp, domains }, fetcher) : null,
    ]);
    signals.push(...secure.signals, ...matchOpenPhish(local.links.map((l) => l.href), feed), ...(spamhaus?.signals ?? []));
    errors.push(...secure.errors, ...(spamhaus?.errors ?? []));
  }

  return { ran: true, lookups, auth: local.auth, signals, score: sumWeights(signals), fingerprint, linkDomains: domains, errors };
}
