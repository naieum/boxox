import { APP_VERSION } from './release.mjs';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const plain = html => html.replace(/<[^>]*>/g, '').replaceAll('&amp;', '&');

export const docNavigation = [
  ['Get started', [
    ['/docs/', 'Introduction'],
    ['/docs/agent-installation/', 'Install with your agent'],
    ['/docs/requirements/', 'Requirements & costs'],
    ['/docs/free/', 'Install on Workers Free'],
    ['/setup/', 'Deploy Box Ox'],
    ['/docs/owner-access/', 'Protect owner access'],
    ['/docs/connect-domain/', 'Connect a domain'],
    ['/docs/cloudflare-connection/', 'Cloudflare connection'],
    ['/docs/verification/', 'Verify your installation'],
  ]],
  ['Build', [
    ['/docs/api/', 'API & SDK'],
    ['/docs/agent-automation/', 'Agent mail workflows'],
    ['/docs/email-design/', 'Email template design'],
  ]],
  ['Manage', [
    ['/docs/processing/', 'Processing & AI'],
    ['/docs/deliverability/', 'Deliverability'],
    ['/docs/backups/', 'Backups & retention'],
    ['/docs/troubleshooting/', 'Troubleshooting'],
    ['/docs/development/', 'Updates & development'],
    ['/docs/upgrade/', 'Upgrade Box Ox'],
    ['/docs/uninstall/', 'Uninstall Box Ox'],
  ]],
  ['Releases', [
    [`/docs/releases/${APP_VERSION}/`, `Version ${APP_VERSION}`],
    ['/docs/releases/2.4.7/', 'Version 2.4.7'],
    ['/docs/releases/2.4.6/', 'Version 2.4.6'],
    ['/docs/releases/2.4.5/', 'Version 2.4.5'],
    ['/docs/releases/2.4.4/', 'Version 2.4.4'],
    ['/docs/releases/2.4.3/', 'Version 2.4.3'],
    ['/docs/releases/2.4.2/', 'Version 2.4.2'],
    ['/docs/releases/2.4.1/', 'Version 2.4.1'],
    ['/docs/releases/2.4.0/', 'Version 2.4.0'],
    ['/docs/releases/2.3.0/', 'Version 2.3.0'],
    ['/docs/releases/2.2.0/', 'Version 2.2.0'],
    ['/docs/releases/2.1.1/', 'Version 2.1.1'],
    ['/docs/releases/2.1.0/', 'Version 2.1.0'],
    ['/docs/releases/2.0.1/', 'Version 2.0.1'],
    ['/docs/releases/2.0.0/', 'Version 2.0.0'],
  ]],
];

function navigation(path, filter = false) {
  return `<nav aria-label="Documentation pages"${filter ? ' data-doc-nav' : ''}>${docNavigation.map(([group, items]) => `<div class="docs-nav-group"><p>${group}</p>${items.map(([href, label]) => `<a href="${href}"${path === href ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</div>`).join('')}</nav>`;
}

export function docsHeader(mark) {
  return `<a class="skip" href="#main">Skip to content</a><header class="docs-header"><div><a class="wordmark" href="/" aria-label="Box Ox home">${mark}</a><a class="docs-header-label" href="/docs/">Docs</a></div><nav aria-label="Main navigation"><a class="docs-website-link" href="/screenshots/">Screenshots</a><a class="docs-website-link" href="/">Website ↗</a><a class="docs-download-link" href="/downloads/">Downloads</a><a class="button primary" href="/downloads/#agent-install" data-agent-install-cta>Let your agent install <span aria-hidden="true">↗</span></a></nav></header>`;
}

export const docsFooter = `<footer class="docs-footer"><p>Box Ox documentation</p><div><a href="mailto:hello@boxox.dev">Get help ↗</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><button type="button" data-analytics-settings>Analytics settings</button></div></footer>`;

export function docsPage(path, heading, intro, content) {
  const entries = [];
  const ids = new Set([...content.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  content = content.replace(/<h2(?: id="([^"]+)")?>([\s\S]*?)<\/h2>/g, (_, existing, label) => {
    let id = existing || plain(label).toLowerCase().replace(/[^a-z0-9 -]/g, '').replaceAll(' ', '-');
    if (!existing) { const base = id; let i = 2; while (ids.has(id)) id = `${base}-${i++}`; ids.add(id); }
    entries.push([id, plain(label)]);
    return `<h2 id="${id}">${label}<a class="docs-anchor" href="#${id}" aria-label="Link to ${escape(plain(label))}">#</a></h2>`;
  });
  let codeIndex = 0;
  content = content.replace(/<pre><code(?: class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g, (_, language, code) => {
    const id = `docs-code-${++codeIndex}`;
    const prompt = language === 'uninstall-prompt';
    return `<div class="docs-code"><div class="docs-code-bar"><span>${prompt ? 'Agent prompt' : escape(language || 'Code')}</span><button type="button" data-doc-copy="${id}" aria-label="${prompt ? 'Copy uninstall prompt' : `Copy code example ${codeIndex}`}"><span>${prompt ? 'Copy uninstall prompt' : 'Copy code'}</span></button></div><pre tabindex="0"><code id="${id}">${code}</code></pre><p class="sr-only" role="status" data-doc-copy-status></p></div>`;
  });
  // Keep wide reference tables inside the article on small screens.
  content = content.replace(/<table>/g, '<div class="docs-table"><table>').replace(/<\/table>/g, '</table></div>');
  const section = docNavigation.find(([, items]) => items.some(([href]) => href === path))?.[0] || 'Documentation';
  const current = docNavigation.flatMap(([, items]) => items).findIndex(([href]) => href === path);
  const all = docNavigation.flatMap(([, items]) => items);
  const adjacent = [all[current - 1], all[current + 1]];
  const toc = `<nav aria-label="On this page">${entries.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('')}</nav>`;
  return `<div class="docs-layout"><aside class="docs-sidebar"><label class="docs-search"><span class="sr-only">Find a documentation page</span><input type="search" placeholder="Find a page…" data-doc-filter aria-controls="docs-page-list"></label><div id="docs-page-list">${navigation(path, true)}</div><p class="docs-no-results" data-doc-no-results hidden role="status">No matching pages.</p><a class="docs-sidebar-help" href="mailto:hello@boxox.dev">Need help? <span>hello@boxox.dev ↗</span></a></aside><div class="docs-mobile-nav"><details><summary>Browse documentation <span aria-hidden="true">⌄</span></summary>${navigation(path)}</details></div><article class="docs-article"><header class="docs-title"><p>${section}</p><h1>${heading.replace(/\.$/, '')}</h1><p>${intro}</p></header>${entries.length ? `<details class="docs-mobile-toc"><summary>On this page</summary>${toc}</details>` : ''}<div class="docs-content">${content}</div><nav class="docs-pager" aria-label="Adjacent documentation pages">${adjacent.map((page, i) => page ? `<a href="${page[0]}"><span>${i ? 'Next' : 'Previous'}</span><strong>${i ? '' : '← '}${page[1]}${i ? ' →' : ''}</strong></a>` : '<span></span>').join('')}</nav>${docsFooter}</article><aside class="docs-toc">${entries.length ? `<p>On this page</p>${toc}` : ''}<a class="docs-toc-help" href="mailto:hello@boxox.dev?subject=Box%20Ox%20docs%20feedback">Suggest a change ↗</a></aside></div>`;
}

export const docsHome = `<div class="docs-start"><a href="/docs/agent-installation/"><span class="docs-card-icon">✦</span><strong>Install with your agent <span>↗</span></strong><p>Copy the runbook. Review the setup together.</p><span class="docs-card-action">Get the install link →</span></a><a href="/setup/"><span class="docs-card-icon">&gt;_</span><strong>Install it yourself <span>→</span></strong><p>Install in your Cloudflare account, then connect your domain.</p><span class="docs-card-action">Open the setup guide →</span></a></div><h2 id="send-mail">Build with Box Ox</h2><div class="docs-topic-grid"><a href="/docs/api/"><span>01 / API & SDK</span><strong>Send your first message →</strong><p>Authentication, code examples, and endpoints.</p></a><a href="/docs/email-design/"><span>02 / Templates</span><strong>Design a readable email →</strong><p>A short checklist for people and agents.</p></a><a href="/docs/processing/"><span>03 / Processing</span><strong>Choose your filters →</strong><p>Local checks, optional AI, and spending limits.</p></a><a href="/docs/deliverability/"><span>04 / Deliverability</span><strong>Check your domains →</strong><p>DNS, reputation, suppressions, and delivery events.</p></a></div><h2 id="before-installing">Before installing</h2><div class="docs-callout"><strong>Box Ox is free.</strong><p>On Cloudflare Workers Free it installs as an inbox. Cloudflare Workers Paid, from $5/month per account, adds sending and optional AI. Cloudflare bills any infrastructure charges directly.</p><a href="/docs/requirements/">Check requirements & costs →</a></div><h2 id="whats-new">What’s new</h2><p><a href="/docs/releases/${APP_VERSION}/">Version ${APP_VERSION}</a> fixes receiving-domain setup permissions, updates existing OAuth client registrations, and documents reconnection. No migration; SDK and CLI 0.2.0 are unchanged. <a href="/docs/releases/${APP_VERSION}/">Release notes →</a></p>`;
