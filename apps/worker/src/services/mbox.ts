/**
 * mbox serialization for export.
 *
 * FIDELITY, STATED PLAINLY. mbox is the format every mail client can import, so
 * it is what we hand users — but it is a CONVENIENCE format, not a preservation
 * one. The format reserves a line beginning "From " as its record separator, so
 * any such line inside a message body must be escaped (">From "). That mutates
 * bytes, which invalidates a DKIM signature over the body and changes the octet
 * count. A byte-exact archive therefore has to ship the untouched `.eml`
 * objects; the manifest records a SHA-256 of the original so a recipient can
 * verify what they got.
 *
 * Everything here is pure and stream-friendly: no message is ever fully
 * materialised beyond the one being written.
 */

/** RFC 4155 mbox separator: `From <addr> <asctime>`. */
export function mboxFromLine(sender: string, date: Date): string {
  const safe = (sender || "MAILER-DAEMON").replace(/[\s<>]/g, "") || "MAILER-DAEMON";
  // asctime, always in C locale / UTC — mbox readers parse this positionally.
  const d = new Date(date.getTime());
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
  return `From ${safe} ${stamp}\n`;
}

/**
 * Escape mbox record separators inside a message body ("mboxo" quoting).
 *
 * Any line starting with "From " would otherwise be read as the start of the
 * next message, silently truncating this one and corrupting the next. Existing
 * ">From " runs get another ">" so the transformation is reversible.
 */
export function escapeMboxBody(text: string): string {
  return text.replace(/^(>*From )/gm, ">$1");
}

/**
 * Build an RFC822-ish message from the PARSED fields we stored, for mail
 * ingested before original-MIME capture existed.
 *
 * This is a reconstruction, not the original: header order, MIME structure,
 * boundaries, encodings, and any signature are gone, and attachments are
 * referenced rather than embedded. The manifest marks these `synthesized` so a
 * recipient is never misled into believing they hold the original bytes.
 */
export function synthesizeRfc822(msg: {
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  occurredAt: Date;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  text: string | null;
  html: string | null;
  attachments: { filename: string; size: number }[];
}): string {
  const from = msg.fromName ? `${msg.fromName} <${msg.fromEmail}>` : msg.fromEmail;
  const headers = [
    `From: ${from}`,
    `To: ${msg.toEmails.join(", ")}`,
    ...(msg.ccEmails.length ? [`Cc: ${msg.ccEmails.join(", ")}`] : []),
    `Subject: ${msg.subject}`,
    `Date: ${msg.occurredAt.toUTCString()}`,
    ...(msg.rfcMessageId ? [`Message-ID: ${msg.rfcMessageId}`] : []),
    ...(msg.inReplyTo ? [`In-Reply-To: ${msg.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: text/${msg.html && !msg.text ? "html" : "plain"}; charset=utf-8`,
    "X-BoxOx-Reconstructed: yes; original MIME was not captured for this message",
    ...(msg.attachments.length
      ? [
          `X-BoxOx-Attachments: ${msg.attachments
            .map((a) => `${a.filename} (${a.size} bytes)`)
            .join("; ")}`,
        ]
      : []),
  ];
  const body = msg.text ?? msg.html ?? "";
  return `${headers.join("\n")}\n\n${body}\n`;
}

/** Lowercase hex SHA-256 of the given bytes — the manifest's integrity claim. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
