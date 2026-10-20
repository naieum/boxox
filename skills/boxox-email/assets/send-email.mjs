import { BoxOx } from "@boxox/mail";

/** Pass the runtime's environment (process.env in Node or env in Workers). */
export async function sendEmail(env, message, idempotencyKey) {
  const mail = new BoxOx({ key: env.BOXOX_KEY, url: env.BOXOX_URL });
  return mail.messages.send(message, { idempotencyKey });
}
