// Self-contained smoke test: writes a deliberately-risky blueprint to a temp
// dir, then drives the built server over stdio.
// Usage: npm run build && node scripts/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const blueprint = {
  name: "Lead intake (community template)",
  flow: [
    { id: 1, module: "gateway:CustomWebHook", parameters: { hook: 1 }, mapper: {} },
    {
      id: 2,
      module: "http:ActionSendData",
      mapper: {
        url: "http://legacy.example.com/collect",
        headers: [{ name: "Authorization", value: "Bearer sk_live_abc123def456ghi789" }],
        body: "{{1.data}}",
      },
    },
    {
      id: 3,
      module: "builtin:BasicRouter",
      routes: [
        { flow: [{ id: 4, module: "slack:CreateMessage", mapper: { text: "{{2.body}}" } }] },
        { flow: [{ id: 5, module: "airtable:CreateRecord", mapper: { fields: "{{42.out}}" } }] },
      ],
    },
  ],
  metadata: { instant: true, zone: "eu1.make.com", scenario: { maxErrors: 3, confidential: false, dlq: false } },
};

const dir = await mkdtemp(join(tmpdir(), "make-audit-smoke-"));
const path = join(dir, "scenario.blueprint.json");
await writeFile(path, JSON.stringify(blueprint, null, 2));

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] }));

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const calls = [
  ["inspect_blueprint", { path }],
  ["trace_module", { path, id: 2 }],
  ["audit_blueprint", { path }],
  ["trace_module", { path, id: 77 }], // must be isError
];

for (const [name, args] of calls) {
  const res = await client.callTool({ name, arguments: args });
  console.log(`\n== ${name} ${res.isError ? "(isError)" : ""}\n${res.content[0].text.slice(0, 800)}`);
}

await client.close();
await rm(dir, { recursive: true, force: true });
console.log("\nSMOKE OK");
