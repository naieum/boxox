import type { ConversationMessage } from "./api";

export type ReplyMode = "reply" | "reply_all" | "forward";

const unique = (emails: string[], drop: Set<string>) => {
  const seen = new Set<string>();
  return emails.filter((e) => {
    const key = e.toLowerCase();
    if (!key || drop.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * To and Cc for answering one message. Reply goes to the sender (or, for our
 * own message, back to its recipients); reply-all adds everyone else on it,
 * minus the user's own addresses. Forward starts empty.
 */
export function replyRecipients(
  message: Pick<ConversationMessage, "direction" | "fromEmail" | "toEmails" | "ccEmails">,
  mode: ReplyMode,
  own: string[],
): { to: string[]; cc: string[] } {
  if (mode === "forward") return { to: [], cc: [] };
  const mine = new Set(own.map((e) => e.toLowerCase()));
  const primary = message.direction === "outbound" ? message.toEmails : [message.fromEmail];
  const to = unique(primary, mine);
  if (mode === "reply") return { to, cc: [] };
  const rest = message.direction === "outbound" ? message.ccEmails : [...message.toEmails, ...message.ccEmails];
  return { to, cc: unique(rest, new Set([...mine, ...to.map((e) => e.toLowerCase())])) };
}

export function replySubject(subject: string, mode: ReplyMode): string {
  const s = subject || "(no subject)";
  if (mode === "forward") return /^fwd?:/i.test(s) ? s : `Fwd: ${s}`;
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

export function forwardedBody(m: ConversationMessage): string {
  const from = m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail;
  const body = [m.text, m.quotedText].filter(Boolean).join("\n") || m.snippet;
  return [
    "",
    "",
    "---------- Forwarded message ---------",
    `From: ${from}`,
    `Date: ${new Date(m.occurredAt).toUTCString()}`,
    `Subject: ${m.subject}`,
    `To: ${m.toEmails.join(", ")}`,
    ...(m.ccEmails.length ? [`Cc: ${m.ccEmails.join(", ")}`] : []),
    "",
    body,
  ].join("\n");
}

/** The latest message, and unread ones newer than the user's last reply, open; the rest collapse. */
export function initiallyExpanded(messages: Pick<ConversationMessage, "id" | "direction">[], threadUnread: boolean): Set<string> {
  const open = new Set<string>();
  const last = messages.at(-1);
  if (last) open.add(last.id);
  if (threadUnread) {
    for (let i = messages.length - 1; i >= 0 && messages[i]!.direction === "inbound"; i--) open.add(messages[i]!.id);
  }
  return open;
}
