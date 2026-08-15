#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { auditBlueprint, toReport } from "./audit.js";
import { extractRefs, loadBlueprint, maskSecrets } from "./blueprint.js";

const server = new McpServer({ name: "make-audit", version: "0.1.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function guarded<A extends unknown[]>(fn: (...args: A) => Promise<ToolResult>) {
  return async (...args: A): Promise<ToolResult> => {
    try {
      return await fn(...args);
    } catch (err) {
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  };
}

const pathArg = z.string().describe("Path to a Make.com scenario blueprint (.json export)");

server.registerTool(
  "inspect_blueprint",
  {
    title: "Inspect a Make blueprint",
    description:
      "Overview of a Make.com scenario blueprint before importing it: modules, apps used, trigger, routers, error handlers, scenario settings.",
    inputSchema: { path: pathArg },
  },
  guarded(async ({ path }) => {
    const bp = await loadBlueprint(path);
    const apps: Record<string, number> = {};
    for (const m of bp.modules) apps[m.app] = (apps[m.app] ?? 0) + 1;
    const scenario = bp.raw?.metadata?.scenario ?? {};
    return jsonResult({
      name: bp.name,
      zone: bp.raw?.metadata?.zone,
      instant: bp.raw?.metadata?.instant ?? false,
      moduleCount: bp.modules.length,
      apps,
      trigger: bp.modules.length ? `#${bp.modules[0].id} ${bp.modules[0].type}` : undefined,
      routers: bp.modules.filter((m) => Array.isArray(m.raw.routes)).length,
      errorHandlers: bp.modules.filter((m) => Array.isArray(m.raw.onerror) && m.raw.onerror.length > 0).length,
      settings: {
        maxErrors: scenario.maxErrors,
        sequential: scenario.sequential,
        confidential: scenario.confidential,
        dlq: scenario.dlq,
      },
    });
  }),
);

server.registerTool(
  "trace_module",
  {
    title: "Trace a module",
    description:
      "One module in detail: type, parameters and mappings (credential-shaped values masked), which modules it references, and which modules reference it.",
    inputSchema: {
      path: pathArg,
      id: z.number().int().describe("Module id (shown by inspect_blueprint and audit findings)"),
    },
  },
  guarded(async ({ path, id }) => {
    const bp = await loadBlueprint(path);
    const target = bp.modules.find((m) => m.id === id);
    if (!target) {
      throw new Error(`No module with id ${id}. Modules: ${bp.modules.map((m) => `#${m.id} ${m.type}`).join(", ")}`);
    }
    const referencedBy = bp.modules
      .filter((m) => m.id !== id && extractRefs(m.raw.mapper).includes(id))
      .map((m) => `#${m.id} ${m.type}`);
    return jsonResult({
      id: target.id,
      type: target.type,
      location: target.location,
      disabled: target.raw.disabled === true,
      parameters: maskSecrets(target.raw.parameters ?? {}),
      mapper: maskSecrets(target.raw.mapper ?? {}),
      references: extractRefs(target.raw.mapper),
      referencedBy,
    });
  }),
);

server.registerTool(
  "audit_blueprint",
  {
    title: "Audit the blueprint",
    description:
      "Risk report before importing: hardcoded credential-shaped values, dangling module references, plain-http URLs, unfiltered router routes, missing error handling, log-retention settings. Secrets are masked in the output.",
    inputSchema: { path: pathArg },
  },
  guarded(async ({ path }) => jsonResult(toReport(auditBlueprint(await loadBlueprint(path))))),
);

await server.connect(new StdioServerTransport());
