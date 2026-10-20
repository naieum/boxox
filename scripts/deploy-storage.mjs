/** Check activation before provisioning any installation resources. Never enroll in billing. */
export async function checkMailStorage(api, account) {
  try {
    await api('GET', '/r2/buckets?per_page=1');
  } catch (error) {
    if (!error.codes?.includes(10042)) throw error;
    throw new Error(`Enable R2 in this Cloudflare account before deploying: https://dash.cloudflare.com/${account}/r2/overview . Cloudflare requires its checkout flow even on Workers Free. R2 includes free usage; overages are billed by Cloudflare. Box Ox has not created resources or changed subscriptions.`);
  }
}

/** Create missing private buckets; keep existing contents and configuration. */
export async function prepareMailBuckets(config, api) {
  for (const binding of config.r2_buckets ?? []) {
    const path = `/r2/buckets/${encodeURIComponent(binding.bucket_name)}`;
    try {
      await api('GET', path);
    } catch (error) {
      if (error.status !== 404) throw error;
      await api('POST', '/r2/buckets', { name: binding.bucket_name });
    }
  }
}
