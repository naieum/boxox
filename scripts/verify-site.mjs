import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { APP_VERSION, RELEASES, WITHDRAWN_ARTIFACTS, WITHDRAWN_SOURCE_RELEASES } from '../apps/site/release.mjs';

const dist=resolve(process.argv[2]??'apps/site/dist');
const origin='https://boxox.dev';
const headers=readFileSync(join(dist,'_headers'),'utf8');
const sitemap=readFileSync(join(dist,'sitemap.xml'),'utf8');
const routes=[...sitemap.matchAll(/<loc>https:\/\/boxox\.dev([^<]*)<\/loc>/g)].map(m=>m[1]);
assert.equal(routes.length,53,'Expected marketing, screenshots, setup, requirements, uninstall, and human documentation pages');
assert.ok(routes.includes(`/docs/releases/${APP_VERSION}/`),'Current release has human release notes');
assert.ok(routes.includes('/docs/uninstall/'),'Uninstall has a human documentation page');
for(const [slug,competitor] of [['sendgrid','SendGrid'],['postal','Postal'],['cloudflare-email-service','Cloudflare Email Service']]) {
  const path=`/compare/${slug}/`;
  assert.ok(routes.includes(path), `Comparison is in sitemap: ${path}`);
  const comparison=readFileSync(join(dist,`compare/${slug}/index.html`),'utf8');
  assert.ok(comparison.includes('scope="col"')&&comparison.includes('scope="row"'),'Comparison table exposes column and row headings');
  assert.ok(comparison.includes('Sources and scope')&&comparison.includes('Where '+competitor+' is the better fit'),'Comparison includes sources and competitor strengths');
}
const contact=readFileSync(join(dist,'contact/index.html'),'utf8');
assert.ok(contact.includes('id="contact-email"')&&contact.includes('Send message')&&!contact.includes('Open email draft'),'Contact form submits directly and requests a reply email');
const uninstall=readFileSync(join(dist,'docs/uninstall/index.html'),'utf8');
assert.ok(uninstall.includes('Copy uninstall prompt'),'Uninstall prompt has a labeled copy control');
assert.ok(uninstall.includes('https://boxox.dev/uninstall-agent.md'),'Prompt points agents at the uninstall runbook');
assert.ok(existsSync(join(dist,'uninstall-agent.md')),'Machine-readable uninstall runbook ships with the site');
for(const route of ['/docs/releases/2.4.5/','/docs/releases/2.4.4/','/docs/agent-automation/','/docs/releases/2.4.0/','/requirements/','/docs/email-design/','/docs/releases/2.0.1/','/docs/deliverability/','/docs/requirements/','/docs/api/','/docs/processing/','/docs/releases/2.0.0/','/docs/agent-installation/'])assert.ok(routes.includes(route),`Required human page: ${route}`);
const decode=s=>s.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>');
const titles=new Set(),descriptions=new Set();
let checkedLinks=0;
for(const route of routes){
  const html=readFileSync(join(dist,route,'index.html'),'utf8');
  assert.equal([...html.matchAll(/<h1(?:\s[^>]*)?>/g)].length,1,`${route}: one h1`);
  const title=html.match(/<title>(.*?)<\/title>/s)?.[1];
  const description=html.match(/<meta name="description" content="([^"]+)"/s)?.[1];
  assert.ok(title && !titles.has(title),`${route}: unique title`);titles.add(title);
  assert.ok(description && !descriptions.has(description),`${route}: unique description`);descriptions.add(description);
  assert.ok(html.includes(`rel="canonical" href="${origin+route}"`),`${route}: canonical`);
  for(const meta of ['og:title','og:description','og:url','og:image','twitter:card','twitter:image'])assert.ok(html.includes(`="${meta}"`),`${route}: ${meta}`);
  for(const [,json]of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)){
    const records=JSON.parse(json);assert.ok(records.some(r=>r['@type']==='WebPage'&&r.url===origin+route));
    const hash=createHash('sha256').update(json).digest('base64');const routeHeaders=headers.split(/\n\n/).find(block=>block.startsWith(route+'\n'));
    assert.ok(routeHeaders?.includes(`'sha256-${hash}'`),`${route}: own schema allowed by route CSP`);
    assert.equal([...routeHeaders.matchAll(/'sha256-/g)].length,1,`${route}: no unrelated inline script hashes`);
  }
  assert.ok(!/<script[^>]+src="https?:/.test(html) && !/<link[^>]+rel="stylesheet"[^>]+href="https?:/.test(html),`${route}: self-hosted scripts and styles`);
  const markup=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
  for(const [,attr,raw]of markup.matchAll(/\b(href|src)="([^"]+)"/g)){
    const target=new URL(decode(raw),origin+route);if(target.origin!==origin)continue;
    const local=join(dist,decodeURIComponent(target.pathname),target.pathname.endsWith('/')?'index.html':'');
    assert.ok(existsSync(local),`${route}: missing ${attr} ${raw}`);checkedLinks++;
    if(target.hash && local.endsWith('.html')){
      const destination=readFileSync(local,'utf8');const id=decodeURIComponent(target.hash.slice(1));
      assert.ok(destination.includes(`id="${id}"`),`${route}: missing anchor ${raw}`);
    }
  }
}
const blocks=headers.split(/\n\n/);
assert.ok(headers.split('\n').every(line=>line.length<=2000),'Cloudflare header-line limit');
assert.ok(blocks.filter(block=>block.trim()).length<=100,'Cloudflare header-rule limit');
for(const route of routes)assert.ok(blocks.some(b=>b.startsWith(route+'\n')&&b.includes('Cache-Control: no-cache')),`${route}: revalidate HTML while preserving immutable font caching`);
assert.ok(!blocks.find(b=>b.startsWith('/downloads/*\n'))?.includes('noindex'),'Downloads landing must be indexable');
assert.ok(headers.includes("form-action 'none'"));
assert.ok(headers.includes("Cache-Control: public, no-transform"),"Prevent automatic third-party script injection before consent");
const spec=JSON.parse(readFileSync(join(dist,'downloads/boxox-openapi-2.0.0.json'),'utf8'));
const collection=JSON.parse(readFileSync(join(dist,'downloads/boxox-postman-2.0.0.json'),'utf8'));
assert.equal(collection.variable.find(v=>v.key==='apiKey').value,'');
const endpoints=Object.entries(spec.paths).flatMap(([path,ops])=>Object.keys(ops).filter(m=>['get','post','put','patch','delete'].includes(m)).map(m=>m.toUpperCase()+' '+path.replace(/\{([^}]+)\}/g,':$1'))).sort();
const requests=collection.item.flatMap(group=>group.item).map(item=>item.request.method+' '+item.request.url.raw.replace('{{baseUrl}}','')).sort();
assert.deepEqual(requests,endpoints);assert.equal(requests.length,37);
for(const line of readFileSync(join(dist,'downloads/RESOURCE-SHA256SUMS.txt'),'utf8').trim().split('\n')){
  const [hash,name]=line.split('  ');assert.equal(createHash('sha256').update(readFileSync(join(dist,'downloads',name))).digest('hex'),hash);
}
const release=JSON.parse(readFileSync(join(dist,'downloads/release.json'),'utf8'));
assert.deepEqual(release,JSON.parse(readFileSync(`apps/site/release-v${APP_VERSION}.json`,'utf8')),'Current release metadata');
const agentGuide=readFileSync(join(dist,'install-agent.md'),'utf8');
assert.ok(agentGuide.includes(`Box Ox ${release.version} is a self-published`),'Agent runbook identifies the current source release');
const currentSkill=release.artifacts.find(a=>a.name.startsWith('boxox-email-skill-'));
assert.ok(currentSkill,'Current release includes an email skill');
assert.ok(agentGuide.includes(`Application integration skill: ${origin}/downloads/${currentSkill.name}`),'Agent runbook installs the current email skill');
for (const version of RELEASES) {
  const archived=JSON.parse(readFileSync(`apps/site/release-v${version}.json`,'utf8'));
  assert.deepEqual(JSON.parse(readFileSync(join(dist,`downloads/v${version}/release.json`),'utf8')),archived,'Historical manifest preserved');
  for (const artifact of archived.artifacts) {
    if ((artifact.name === 'boxox-v2.zip' && WITHDRAWN_SOURCE_RELEASES.includes(version)) || WITHDRAWN_ARTIFACTS.includes(artifact.name)) {
      assert.ok(!existsSync(join(dist,`downloads/v${version}`,artifact.name)),'Withdrawn artifact must not be uploaded');
      assert.ok(!existsSync(join(dist,'downloads',artifact.name)) || artifact.name === 'boxox-v2.zip','Withdrawn artifact must not be uploaded');
      const withdrawal=JSON.parse(readFileSync(join(dist,`downloads/v${version}/withdrawal.json`),'utf8'));
      assert.equal(withdrawal.status,'withdrawn');assert.ok(withdrawal.artifacts.some(a=>a.artifact===artifact.name),`Withdrawal recorded: ${version}/${artifact.name}`);
    } else assert.equal(createHash('sha256').update(readFileSync(join(dist,`downloads/v${version}`,artifact.name))).digest('hex'),artifact.sha256,`Version ${version} artifact preserved: ${artifact.name}`);
  }
}
const home=readFileSync(join(dist,'index.html'),'utf8');
assert.ok(home.includes(`softwareVersion\":\"${APP_VERSION}\"`),'Search metadata identifies the current application release');
for (const route of routes) assert.ok(readFileSync(join(dist,route,'index.html'),'utf8').includes(`<meta name=\"boxox-release-version\" content=\"${APP_VERSION}\">`),`${route}: analytics release metadata`);
assert.ok(!home.includes('data-code-group'),'Homepage code example removed');
assert.equal([...home.matchAll(/href="\/docs\/deliverability\/#/g)].length,6,'Six documented deliverability tools');
for(const [,href]of home.matchAll(/<a[^>]+href="([^"]+)"/g)){
  const url=new URL(decode(href),origin);if(url.origin!==origin)continue;
  assert.ok(url.pathname.endsWith('/'),`Homepage navigation must open an HTML page: ${href}`);
}
for(const route of routes.filter(route=>route.startsWith('/docs/')||route==='/setup/')){
  const html=readFileSync(join(dist,route,'index.html'),'utf8');
  assert.ok(html.includes('class="docs-sidebar"'),`${route}: documentation navigation`);
  assert.ok(html.includes(`href="${route}" aria-current="page"`),`${route}: active documentation page`);
  assert.ok(!html.includes('resend.com/blog/design-email-for-humans-and-agents'),`${route}: no competitor design attribution`);
  assert.equal([...html.matchAll(/<pre[^>]*>/g)].length,[...html.matchAll(/data-doc-copy=/g)].length,`${route}: every code block has a copy control`);
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,`${route}: unique navigation targets`);
}
for(const name of [...WITHDRAWN_ARTIFACTS,'boxox-brand-assets-1.0.0.zip','boxox-brand-assets-1.1.0.zip'])assert.ok(!existsSync(join(dist,'downloads',name)),`Withdrawn download removed: ${name}`);
const apiPage=readFileSync(join(dist,'docs/api/index.html'),'utf8');
assert.equal([...apiPage.matchAll(/class="api-operation"/g)].length,37,'Human API reference covers every operation');
console.log(`Verified ${routes.length} pages, ${checkedLinks} internal links/assets, SEO metadata, CSP schema hashes, ${requests.length} Postman operations, resource hashes, preserved manifests and withdrawn source inventory`);
