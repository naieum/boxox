/** Resolve the application origin before provisioning or deploying resources. */
export async function configureDeploymentUrl(config, requestedUrl, getWorkersSubdomain, options = {}) {
  let origin;
  if (requestedUrl?.trim()) {
    const url = new URL(requestedUrl.trim());
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password || url.port) {
      throw new Error('BOXOX_URL must be an HTTPS origin without a path, query, credentials, or port');
    }
    origin = url.origin;
  }
  const usesWorkersDev = !origin || new URL(origin).hostname.endsWith('.workers.dev');
  if (usesWorkersDev) {
    let registration;
    try {
      registration = await getWorkersSubdomain();
    } catch (error) {
      if (error.status !== 404) throw error;
      if (options.createWorkersSubdomain) {
        const account = options.accountId;
        if (!/^[a-f0-9]{32}$/.test(account ?? '')) throw new Error('A valid account ID is required to initialize workers.dev');
        const originHost = origin && new URL(origin).hostname;
        const prefix = `${config.name}.`;
        if (originHost && (!originHost.startsWith(prefix) || originHost.slice(prefix.length).split('.').length !== 3)) {
          throw new Error('BOXOX_URL must use this Worker’s address before initializing workers.dev');
        }
        const requested = originHost?.slice(prefix.length, -'.workers.dev'.length);
        const chosen = options.requestedSubdomain?.trim() || requested || `boxox-${account.slice(0, 12)}`;
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(chosen)) throw new Error('BOXOX_WORKERS_SUBDOMAIN must be a valid lowercase subdomain');
        if (requested && requested !== chosen) throw new Error('BOXOX_URL and BOXOX_WORKERS_SUBDOMAIN must use the same account subdomain');
        await options.createWorkersSubdomain(chosen);
        // Confirm the account registration instead of assuming that a write succeeded.
        registration = await getWorkersSubdomain();
        if (registration?.subdomain !== chosen) throw new Error('Cloudflare has not confirmed the requested workers.dev address. Check Workers & Pages before retrying.');
      }
    }
    const subdomain = registration?.subdomain;
    if (typeof subdomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
      throw new Error('Choose your free workers.dev account subdomain in Cloudflare → Workers & Pages before deploying. A custom domain is not required.');
    }
    const workersOrigin = `https://${config.name}.${subdomain}.workers.dev`;
    if (origin && origin !== workersOrigin) {
      throw new Error(`BOXOX_URL must use this Worker’s address: ${workersOrigin}`);
    }
    origin = workersOrigin;
    config.routes = [];
    config.workers_dev = true;
  } else {
    config.routes = [{ pattern: new URL(origin).hostname, custom_domain: true }];
    config.workers_dev = false;
  }
  config.preview_urls = false;
  config.vars = { ...config.vars, PUBLIC_URL: origin };
  return origin;
}
