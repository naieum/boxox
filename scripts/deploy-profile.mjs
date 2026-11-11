// A zone's Free/Pro/Business plan says nothing about its account's Workers plan.
// Subscription IDs: https://developers.cloudflare.com/tenant/reference/subscriptions/
const paidWorkersPlans = new Set([
  'WORKERS_PAID', 'PARTNERS_WORKERS_ENT', 'PARTNERS_WORKERS_SS', 'PARTNERS_WORKERS_BASIC',
]);
const activeStates = new Set(['paid', 'provisioned', 'trial']);

export function workersPlanFromSubscriptions(subscriptions) {
  if (!Array.isArray(subscriptions)) throw new Error('Cloudflare returned an invalid subscription list');
  let unknownWorkersPlan = false;
  for (const subscription of subscriptions) {
    const id = subscription.rate_plan?.id?.toUpperCase();
    if (!id) continue;
    if (paidWorkersPlans.has(id) && !subscription.state) throw new Error('Cloudflare did not report the Workers subscription state. Select BOXOX_PLAN after checking the dashboard.');
    if (!activeStates.has(subscription.state?.toLowerCase())) continue;
    if (paidWorkersPlans.has(id)) return 'paid';
    if (id.includes('WORKERS') && id !== 'WORKERS_FREE') unknownWorkersPlan = true;
  }
  if (unknownWorkersPlan) throw new Error('Unrecognized Workers subscription. Select BOXOX_PLAN=free or paid after checking your Cloudflare dashboard.');
  return 'free';
}

export async function selectDeploymentPlan(api, choice = 'auto', options = {}) {
  if (!['auto', 'free', 'paid'].includes(choice)) throw new Error('BOXOX_PLAN must be auto, free, or paid');
  if (choice !== 'auto') return { plan: choice, source: 'installer choice' };
  // An installed profile is a fact about this installation; a Paid one is never downgraded by a guess.
  if (options.installed === 'free' || options.installed === 'paid') return { plan: options.installed, source: 'existing installation' };
  try {
    return { plan: workersPlanFromSubscriptions(await api('GET', '/subscriptions')), source: 'Cloudflare subscription' };
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) throw error;
    // Cloudflare offers applications no billing permission, so the owner answers instead.
    const answer = (await options.ask?.('Is this Cloudflare account on Workers Free or Workers Paid? Check Workers & Pages → Plans if unsure. Type free or paid: '))?.trim().toLowerCase();
    if (answer === 'free' || answer === 'paid') return { plan: answer, source: 'installer choice' };
    throw new Error('Cloudflare did not allow the Workers plan check. Check Workers & Pages in your dashboard, then set BOXOX_PLAN=free or BOXOX_PLAN=paid and rerun (a read-only Billing Read token in BOXOX_BILLING_TOKEN also works). No resources or subscriptions have been changed.');
  }
}

export function applyDeploymentProfile(config, plan) {
  if (!['free', 'paid'].includes(plan)) throw new Error('Expected a verified or explicitly selected Workers plan');
  config.vars = { ...config.vars, BOXOX_EDITION: plan };
  if (plan === 'paid') return config;
  delete config.send_email;
  delete config.ai;
  delete config.vectorize;
  delete config.browser;
  delete config.analytics_engine_datasets;
  config.workflows = config.workflows.filter(workflow => workflow.binding !== 'SEND_WORKFLOW');
  config.queues.producers = config.queues.producers.filter(queue => queue.binding !== 'INGEST_QUEUE');
  const webhook = config.queues.producers.find(queue => queue.binding === 'WEBHOOK_QUEUE');
  config.queues.consumers = config.queues.consumers.filter(queue => queue.queue === webhook.queue)
    .map(queue => ({ ...queue, max_batch_size: 1 }));
  // Queues Free retains messages for 24 hours. Do not inherit a Paid retention.
  delete config.limits;
  return config;
}
