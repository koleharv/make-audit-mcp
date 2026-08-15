# make-audit-mcp — Design

**Date:** 2026-08-14
**Goal:** Eighth portfolio MCP server: auditor for Make.com (Integromat)
scenario blueprints.

## Idea selection

Make's official MCP server executes scenarios; community MCP tooling builds
them. Unlike Zapier (Zaps aren't exportable), Make scenarios export as
**blueprint JSON files** that people share widely — and importing someone's
blueprint blindly means importing their webhooks, HTTP calls, and whatever
credentials-shaped strings they left inside. No dedicated blueprint auditor
existed (checked 2026-08-14). Same "audit the file before you trust it"
positioning as xlsx-audit-mcp and the n8n linting precedent.

## What it does

- *"What's in this blueprint before I import it?"* — modules, apps used,
  trigger type, routers, error handlers, scenario settings.
- *"Is it safe and sane?"* — hardcoded credential-shaped values (should be
  Make connections), plain-`http://` calls, unfiltered router routes,
  references to modules that don't exist, missing error handling,
  `confidential` off (bundle data retained in logs), disabled-but-present
  modules.
- *"What feeds module 5?"* — mapping-reference tracing in both directions.

## Blueprint model

A blueprint is `{name, flow: [module...], metadata}` where modules nest:
routers carry `routes: [{flow: [...]}]` and any module can carry `onerror:
[module...]`. Mapping expressions look like `{{1.data}}` or
`{{formatDate(2.date; "X")}}` — the digits before a field access are module
IDs. The walker recurses through routes and error handlers; the reference
extractor only counts `N.` when followed by an identifier, so numeric
literals like `{{parseNumber(3.14)}}` don't produce phantom module 3 refs.

## Architecture

- `src/blueprint.ts` — load + recursive module walk + reference extraction +
  secret masking. Pure, zero deps.
- `src/audit.ts` — the checks, pure.
- `src/index.ts` — MCP wiring, three tools.

Secret-shaped values are **masked everywhere** (first 4 chars + length):
the auditor must never amplify a leaked token into the model's context.

## Tools

| Tool | Purpose |
|------|---------|
| `inspect_blueprint(path)` | Scenario overview: modules, apps, trigger, routers, error handling, settings |
| `trace_module(path, id)` | One module: type, masked parameters/mapper, references out and in |
| `audit_blueprint(path)` | Findings report (errors / warnings / info) |

## Limitations (documented)

Execution-order validation across router branches is not attempted (existence
checks only). Connection *contents* are not in blueprints — Make strips them
on export — so the auditor flags literal credential-shaped strings, which is
exactly what shouldn't be there.

## Testing

Synthetic blueprints built in-suite: nested router flows, onerror chains,
a hardcoded Bearer token, an `http://` URL, a dangling `{{99.x}}` reference,
numeric-literal false-positive guard. Smoke writes a blueprint to a temp dir
and drives all three tools over stdio.
