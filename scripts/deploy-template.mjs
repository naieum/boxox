import { applyDeploymentProfile } from './deploy-profile.mjs';

/** Keep the complete workspace while exposing only Free bindings to Cloudflare's form. */
export function freeDeploymentTemplate(config, sourceCommit, paidConfigText) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Expected an immutable source commit');
  if (!config.browser || !config.send_email) throw new Error('Generate the template from the full main configuration');
  const free = applyDeploymentProfile(structuredClone(config), 'free');
  return new Map([
    ['wrangler.jsonc', JSON.stringify(free, null, 2) + '\n'],
    ['wrangler.paid.jsonc', paidConfigText],
    ['.boxox-template.json', JSON.stringify({ schema: 1, profile: 'free', sourceCommit }, null, 2) + '\n'],
  ]);
}
