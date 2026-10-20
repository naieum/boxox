import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const SERVICE = "boxox";
export interface Keychain { get(url: string): Promise<string>; set(url: string, key: string): Promise<void> }

/** Secrets go to the OS credential store; the config file contains only the URL. */
export const keychain: Keychain = {
  async get(url) {
    try {
      if (process.platform === "darwin") return (await exec("security", ["find-generic-password", "-s", SERVICE, "-a", url, "-w"])).stdout.trim();
      if (process.platform === "linux") return (await exec("secret-tool", ["lookup", "service", SERVICE, "url", url])).stdout.trim();
    } catch { throw new Error("No saved Box Ox key. Run boxox login or set BOXOX_KEY."); }
    throw new Error("OS keychain unsupported here; use BOXOX_KEY.");
  },
  async set(url, key) {
    try {
      if (process.platform === "darwin") { await exec("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", url, "-w", key]); return; }
      if (process.platform === "linux") {
        await new Promise<void>((resolve, reject) => {
          const child = execFile("secret-tool", ["store", "--label=Box Ox API key", "service", SERVICE, "url", url], (error) => error ? reject(error) : resolve());
          child.stdin!.end(key);
        });
        return;
      }
    } catch { throw new Error("Could not store the key in the OS keychain. Install/unlock the credential store, or use BOXOX_KEY."); }
    throw new Error("OS keychain unsupported here; use BOXOX_KEY.");
  },
};
export function configPath() { return join(process.env.BOXOX_CONFIG_DIR ?? join(homedir(), ".config", "boxox"), "config.json"); }
export async function savedUrl(): Promise<string | undefined> {
  try { return (JSON.parse(await readFile(configPath(), "utf8")) as { url?: string }).url; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Invalid Box Ox config file"); }
}
export async function saveUrl(url: string) {
  const path = configPath();
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ url }) + "\n", { mode: 0o600 });
}
export function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("BOXOX_URL must be an origin without credentials, path, query or fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Use HTTPS (HTTP is allowed only on localhost)");
  return url.origin;
}
