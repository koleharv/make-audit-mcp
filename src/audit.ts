// Blueprint audit checks. Pure logic over the loaded blueprint.

import { extractRefs, mask, stringEntries, type Blueprint, type ModuleEntry } from "./blueprint.js";

export interface Finding {
  severity: "error" | "warning" | "info";
  module?: string;
  message: string;
}

const CREDENTIAL_KEY = /(token|secret|api[-_]?key|apikey|password|authorization)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9\-_.]{12,}/i;

function moduleLabel(m: ModuleEntry): string {
  return `#${m.id} ${m.type}`;
}

export function auditBlueprint(bp: Blueprint): Finding[] {
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], message: string, m?: ModuleEntry) =>
    findings.push({ severity, ...(m ? { module: moduleLabel(m) } : {}), message });

  const ids = new Set(bp.modules.map((m) => m.id));
  let hasErrorHandler = false;

  for (const m of bp.modules) {
    // Dangling mapping references — common after hand-editing or merging blueprints.
    for (const ref of extractRefs(m.raw.mapper)) {
      if (!ids.has(ref)) add("error", `mapping references module ${ref}, which does not exist in this blueprint`, m);
    }

    // Credential-shaped literals. Connections are stripped on export, so any
    // literal secret here is exactly what should NOT be in a shared file.
    for (const { path, text } of stringEntries({ parameters: m.raw.parameters, mapper: m.raw.mapper })) {
      const key = path.split(/[.[]/).pop() ?? "";
      if (CREDENTIAL_KEY.test(key) && text.length >= 8 && !text.includes("{{")) {
        add("warning", `credential-shaped literal at ${path}: ${mask(text)} — use a Make connection instead`, m);
      } else if (BEARER.test(text)) {
        add("warning", `hardcoded Bearer token at ${path} — use a Make connection instead`, m);
      }
      if (/^http:\/\//i.test(text.trim())) {
        add("warning", `plain http:// URL at ${path} — data travels unencrypted`, m);
      }
    }

    if (m.type.startsWith("gateway:CustomWebHook")) {
      add("info", "webhook trigger — anyone with the URL can invoke this scenario; validate payloads", m);
    }

    if (Array.isArray(m.raw.routes) && m.raw.routes.length > 1) {
      const filtered = m.raw.routes.filter((r: any) => r?.flow?.[0]?.filter).length;
      if (filtered === 0) {
        add("warning", `router has ${m.raw.routes.length} routes and none are filtered — every bundle takes every route`, m);
      }
    }

    if (m.raw.disabled === true) add("info", "module is disabled but still in the blueprint", m);
    if (Array.isArray(m.raw.onerror) && m.raw.onerror.length > 0) hasErrorHandler = true;
  }

  const scenario = bp.raw?.metadata?.scenario ?? {};
  if (!hasErrorHandler && scenario.dlq !== true) {
    add("info", "no error handlers and DLQ is off — failed runs will be lost after retries");
  }
  if (scenario.confidential === false) {
    add("info", "confidential=false — execution logs retain bundle data (fine unless payloads are sensitive)");
  }

  const rank = { error: 0, warning: 1, info: 2 } as const;
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export interface AuditReport {
  errors: number;
  warnings: number;
  infos: number;
  findings: Finding[];
}

export function toReport(findings: Finding[]): AuditReport {
  return {
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    infos: findings.filter((f) => f.severity === "info").length,
    findings,
  };
}
