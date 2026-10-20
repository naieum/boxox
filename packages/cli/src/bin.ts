#!/usr/bin/env node
import { run } from "./cli.js";
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try { await run(process.argv.slice(2), { signal: controller.signal }); }
catch (error) {
  if (!controller.signal.aborted) {
    let message = error instanceof Error ? error.message : "Command failed";
    message = message.replace(/bx[mk]_[A-Za-z0-9_-]+|whsec_[A-Za-z0-9+/=_-]+/g, "[redacted]");
    process.stderr.write(`boxox: ${message}\n`); process.exitCode = 1;
  }
}
