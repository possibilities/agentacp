#!/usr/bin/env bun
import { ownerFromEnv } from "./environment.ts";
import { BrokerClient, serve } from "./service.ts";
import { cliInput, guidance, guide, help } from "./tools.ts";
import { fail, ok, refused } from "./errors.ts";
import { mcp } from "./mcp.ts";
import { monitor } from "./monitor.ts";

process.umask(0o077);
const args = process.argv.slice(2);
const command = args[0];
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop); process.once("SIGTERM", stop);
process.stdout.on("error", stop);
try {
  if (["--help", "-h", "--agent-teaser"].includes(command ?? "") || !command) console.log(help());
  else if (command === "--agent-help") console.log(guidance);
  else if (command === "guide") {
    if (args.slice(1).some(arg => arg !== "--json")) fail("invalid_request", "guide takes only --json");
    console.log(JSON.stringify(ok(guide())));
  } else if (["serve", "mcp", "monitor"].includes(command)) {
    if (args.length > 1) fail("invalid_request", `${command} takes no arguments`);
    if (command === "serve") await serve(controller.signal);
    else {
      const owner = ownerFromEnv();
      if (command === "mcp") await mcp(owner, controller.signal);
      else await monitor(owner, controller.signal);
    }
  } else if (["opencode", "devin"].includes(command)) {
    const owner = ownerFromEnv();
    const name = `${command}_${args[1] ?? ""}`;
    const input = cliInput(name, args.slice(2));
    const client = await BrokerClient.connect("cli", owner);
    controller.signal.addEventListener("abort", () => client.close(), { once: true });
    try { console.log(JSON.stringify(ok(await client.call(name, input)))); } finally { client.close(); }
  } else fail("invalid_request", `Unknown command ${command}`);
} catch (error) {
  const envelope = refused(error);
  if (["mcp", "monitor", "serve"].includes(command ?? "")) console.error(JSON.stringify(envelope));
  else console.log(JSON.stringify(envelope));
  process.exitCode = envelope.error?.code === "invalid_request" ? 2 : 1;
} finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
