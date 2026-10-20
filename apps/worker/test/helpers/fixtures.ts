/** Recorded Cloudflare API and event payloads, bundled at build time (workerd has no disk). */
const files = import.meta.glob<Record<string, unknown>>("../fixtures/cf/*.json", { eager: true, import: "default" });

export function fixture(name: string): any {
  const json = files[`../fixtures/cf/${name}`];
  if (!json) throw new Error(`no fixture ${name}`);
  return structuredClone(json);
}
