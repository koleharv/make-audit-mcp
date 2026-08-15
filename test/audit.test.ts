import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditBlueprint, toReport } from "../src/audit.js";
import { extractRefs, loadBlueprint, maskSecrets, walkModules, type Blueprint } from "../src/blueprint.js";

export const BLUEPRINT = {
  name: "Lead intake",
  flow: [
    { id: 1, module: "gateway:CustomWebHook", version: 1, parameters: { hook: 111 }, mapper: {} },
    {
      id: 2,
      module: "http:ActionSendData",
      mapper: {
        url: "http://legacy.example.com/collect",
        method: "post",
        headers: [{ name: "Authorization", value: "Bearer sk_live_abcdef123456789012345" }],
        body: "{{1.data}} and also {{formatDate(1.date; \"YYYY\")}} but not {{parseNumber(3.14)}}",
      },
    },
    {
      id: 4,
      module: "builtin:BasicRouter",
      routes: [
        { flow: [{ id: 5, module: "slack:CreateMessage", mapper: { text: "{{2.body}}", api_key: "supersecretvalue99" } }] },
        { flow: [{ id: 6, module: "airtable:CreateRecord", mapper: { fields: "{{99.output}}" }, disabled: true }] },
      ],
    },
  ],
  metadata: {
    instant: true,
    zone: "eu1.make.com",
    scenario: { roundtrips: 1, maxErrors: 3, autoCommit: true, sequential: false, confidential: false, dlq: false },
  },
};

let dir: string;
let bp: Blueprint;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "make-audit-test-"));
  const p = join(dir, "scenario.json");
  await writeFile(p, JSON.stringify(BLUEPRINT));
  bp = await loadBlueprint(p);
});

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("walkModules", () => {
  it("recurses through router routes", () => {
    expect(bp.modules.map((m) => m.id)).toEqual([1, 2, 4, 5, 6]);
    expect(bp.modules.find((m) => m.id === 5)?.location).toBe("flow[2].routes[0][0]");
  });

  it("recurses through onerror chains", () => {
    const flow = [{ id: 1, module: "a:b", onerror: [{ id: 2, module: "builtin:Break" }] }];
    expect([...walkModules(flow, "flow")].map((m) => m.id)).toEqual([1, 2]);
  });
});

describe("extractRefs", () => {
  it("finds refs in plain and function-wrapped mappings", () => {
    expect(extractRefs(bp.modules[1].raw.mapper)).toEqual([1]);
    expect(extractRefs({ a: "{{12.foo}} {{sum(7.bar; 12.baz)}}" })).toEqual([7, 12]);
  });

  it("does not mistake numeric literals for module refs", () => {
    expect(extractRefs({ a: "{{parseNumber(3.14)}}" })).toEqual([]);
    expect(extractRefs({ a: "pi is 3.14 outside mappings too" })).toEqual([]);
  });
});

describe("maskSecrets", () => {
  it("masks credential-shaped keys and Bearer tokens, leaves mappings alone", () => {
    const masked = maskSecrets({
      api_key: "supersecretvalue99",
      note: "Bearer sk_live_abcdef123456789012345 inline",
      dynamic: { token: "{{1.token}}" },
    }) as any;
    expect(masked.api_key).toBe("supe… (18 chars)");
    expect(masked.note).toContain("Bearer [masked]");
    expect(masked.dynamic.token).toBe("{{1.token}}");
  });
});

describe("auditBlueprint", () => {
  it("produces the expected findings", () => {
    const report = toReport(auditBlueprint(bp));

    // dangling {{99.output}} in module 6
    expect(report.errors).toBe(1);
    expect(report.findings[0]).toMatchObject({ severity: "error", module: "#6 airtable:CreateRecord" });
    expect(report.findings[0].message).toContain("references module 99");

    const warnings = report.findings.filter((f) => f.severity === "warning").map((f) => f.message);
    expect(warnings.some((m) => m.includes("hardcoded Bearer token"))).toBe(true);
    expect(warnings.some((m) => m.includes("plain http:// URL"))).toBe(true);
    expect(warnings.some((m) => m.includes("credential-shaped literal") && m.includes("supe… (18 chars)"))).toBe(true);
    expect(warnings.some((m) => m.includes("none are filtered"))).toBe(true);

    const infos = report.findings.filter((f) => f.severity === "info").map((f) => f.message);
    expect(infos.some((m) => m.includes("webhook trigger"))).toBe(true);
    expect(infos.some((m) => m.includes("module is disabled"))).toBe(true);
    expect(infos.some((m) => m.includes("no error handlers"))).toBe(true);
    expect(infos.some((m) => m.includes("confidential=false"))).toBe(true);
  });

  it("stays quiet on a clean blueprint", () => {
    const clean: any = {
      path: "x",
      name: "clean",
      raw: { metadata: { scenario: { confidential: true, dlq: true } } },
      modules: [
        {
          id: 1,
          type: "slack:CreateMessage",
          app: "slack",
          location: "flow[0]",
          raw: { id: 1, module: "slack:CreateMessage", mapper: { text: "hello {{1.name}}" }, onerror: [{ id: 2, module: "builtin:Break" }] },
        },
      ],
    };
    expect(auditBlueprint(clean)).toEqual([]);
  });
});

describe("loadBlueprint errors", () => {
  it("rejects non-JSON and non-blueprints", async () => {
    const bad = join(dir, "bad.json");
    await writeFile(bad, "not json at all");
    await expect(loadBlueprint(bad)).rejects.toThrow(/not valid JSON/);
    const noflow = join(dir, "noflow.json");
    await writeFile(noflow, JSON.stringify({ name: "x" }));
    await expect(loadBlueprint(noflow)).rejects.toThrow(/no top-level "flow"/);
  });
});
