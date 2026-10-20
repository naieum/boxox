import { verifyWebhookRequest, WebhookVerificationError } from "@boxox/mail";

/** onEvent must durably deduplicate id before applying business effects. */
export async function handleWebhook(request, env, onEvent) {
  let event;
  try { event = await verifyWebhookRequest(request, env.BOXOX_WEBHOOK_SECRET); }
  catch (error) {
    if (error instanceof WebhookVerificationError) return new Response("Invalid webhook signature", { status: 400 });
    throw error;
  }
  await onEvent(event, request.headers.get("webhook-id"));
  return new Response(null, { status: 204 });
}
