# make-audit-mcp

An [MCP](https://modelcontextprotocol.io) server that **audits Make.com (Integromat) scenario blueprints before you import them**. Blueprints are shared everywhere — template galleries, forums, "1000 automation" bundles — and importing one means importing its webhooks, HTTP calls, and whatever credential-shaped strings the author left inside.

- *"What's in this blueprint?"* — modules, apps, trigger, routers, error handling, scenario settings
- *"Is it safe to import?"* — hardcoded tokens (masked in output), plain-`http://` calls, dangling module references, unfiltered router routes, missing error handling, log-retention settings
- *"What feeds module 5?"* — mapping-reference tracing in both directions

[Make's official MCP](https://github.com/integromat/make-mcp-server) runs your scenarios; this one reviews the files before they become scenarios. Local files only.

## Quick start

**Claude Code**

```bash
claude mcp add make-audit -- npx -y make-audit-mcp
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "make-audit": {
      "command": "npx",
      "args": ["-y", "make-audit-mcp"]
    }
  }
}
```

Then: *"Audit C:\\Downloads\\lead-intake.blueprint.json before I import it."*

## Tools

| Tool | What it does |
|------|--------------|
| `inspect_blueprint` | Scenario overview: modules, apps, trigger, routers, error handlers, settings |
| `trace_module` | One module in detail — parameters/mappings (secrets masked), references out and in |
| `audit_blueprint` | Findings report: errors / warnings / info |

## What the auditor checks

- **Credential-shaped literals** in parameters or mappings (`api_key`, `token`, `Authorization`, `Bearer …`) — connections are stripped on export, so any literal secret is exactly what shouldn't be in a shared file. Values are **masked** (`supe… (18 chars)`) everywhere, including in findings — the auditor never amplifies a leaked token into the model's context.
- **Dangling references** — mappings like `{{99.output}}` pointing at modules that don't exist (common after hand-editing or merging blueprints). The extractor understands Make's expression syntax: `{{formatDate(2.date; "X")}}` references module 2, while `{{parseNumber(3.14)}}` references nothing.
- Plain-`http://` URLs, webhook triggers (anyone with the URL can invoke), routers where no route is filtered, disabled-but-present modules, no error handlers with DLQ off, `confidential=false` log retention.

Known limitation: execution-order validation across router branches is not attempted — reference checks are existence-only.

## Development

```bash
npm install
npm test                 # offline tests — synthetic blueprints built in-suite
npm run build            # tsc → dist/
node scripts/smoke.mjs   # end-to-end: generates a blueprint, drives the server over stdio
```

Architecture: [`src/blueprint.ts`](src/blueprint.ts) (recursive module walk, reference extraction, secret masking) and [`src/audit.ts`](src/audit.ts) (checks) are pure logic; [`src/index.ts`](src/index.ts) is the MCP wiring. Zero runtime deps beyond the MCP SDK.

Not affiliated with or endorsed by Make / Celonis.

## License

MIT
