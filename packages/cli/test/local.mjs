import { unstable_dev, unstable_splitSqlQuery } from "wrangler";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function startLocal() {
  const worker = await unstable_dev(fileURLToPath(new URL("worker.ts", import.meta.url)), {
    config: fileURLToPath(new URL("wrangler.jsonc", import.meta.url)),
    ip: "127.0.0.1", port: 0, local: true, persist: false,
    experimental: { disableExperimentalWarning: true }, logLevel: "error",
  });
  const url = `http://${worker.address}:${worker.port}`;
  const migrationDir = new URL("../../../migrations/", import.meta.url);
  const names = (await readdir(migrationDir)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  const queries = (await Promise.all(names.map(async name => unstable_splitSqlQuery(await readFile(new URL(name, migrationDir), "utf8"))))).flat();
  const response = await fetch(url + "/__seed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queries }) });
  if (!response.ok) { await worker.stop(); throw new Error(`Local seed failed: ${await response.text()}`); }
  const management = await response.json();
  return { worker, url, management };
}
