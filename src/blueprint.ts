// Make.com blueprint model: load, recursive module walk, mapping-reference
// extraction, and secret masking. Pure logic, zero deps.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ModuleEntry {
  id: number;
  type: string;
  app: string;
  raw: any;
  /** Where in the tree it sits, e.g. "flow[2].routes[0]" — for readable findings. */
  location: string;
}

export interface Blueprint {
  path: string;
  name?: string;
  raw: any;
  modules: ModuleEntry[];
}

export async function loadBlueprint(rawPath: string): Promise<Blueprint> {
  const path = resolve(rawPath);
  const text = await readFile(path, "utf8").catch(() => {
    throw new Error(`Path not found: ${path}`);
  });
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`Not a blueprint (file is not valid JSON): ${path}`);
  }
  if (!Array.isArray(raw?.flow)) {
    throw new Error(`Not a Make blueprint (no top-level "flow" array): ${path}`);
  }
  return { path, name: raw.name, raw, modules: [...walkModules(raw.flow, "flow")] };
}

/** Depth-first over the module tree: router routes and onerror chains included. */
export function* walkModules(flow: any[], location: string): Generator<ModuleEntry> {
  for (let i = 0; i < (flow ?? []).length; i++) {
    const m = flow[i];
    if (!m || typeof m !== "object") continue;
    const here = `${location}[${i}]`;
    const type = String(m.module ?? "unknown");
    yield { id: Number(m.id), type, app: type.split(":")[0], raw: m, location: here };
    if (Array.isArray(m.routes)) {
      for (let r = 0; r < m.routes.length; r++) {
        yield* walkModules(m.routes[r]?.flow ?? [], `${here}.routes[${r}]`);
      }
    }
    if (Array.isArray(m.onerror)) {
      yield* walkModules(m.onerror, `${here}.onerror`);
    }
  }
}

/**
 * Module IDs referenced by mapping expressions in a value tree.
 * `{{1.data}}` and `{{formatDate(2.date; "X")}}` reference modules 1 and 2;
 * `{{parseNumber(3.14)}}` references nothing — a module ref is digits
 * followed by a dot and an identifier, not a numeric literal.
 */
export function extractRefs(value: unknown): number[] {
  const refs = new Set<number>();
  for (const text of stringValues(value)) {
    for (const span of text.match(/\{\{[^}]*\}\}/g) ?? []) {
      for (const m of span.matchAll(/(?<![\w.])(\d+)\.(?=[A-Za-z_`])/g)) {
        refs.add(Number(m[1]));
      }
    }
  }
  return [...refs].sort((a, b) => a - b);
}

export function* stringValues(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
  } else if (Array.isArray(value)) {
    for (const v of value) yield* stringValues(v);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) yield* stringValues(v);
  }
}

/** Deep-walk with key paths, for findings that must name where a value lives. */
export function* stringEntries(value: unknown, path = ""): Generator<{ path: string; text: string }> {
  if (typeof value === "string") {
    yield { path, text: value };
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* stringEntries(value[i], `${path}[${i}]`);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* stringEntries(v, path ? `${path}.${k}` : k);
  }
}

/** "sk-abcd1234..." → "sk-a… (24 chars)" — never amplify a leaked token. */
export function mask(value: string): string {
  return `${value.slice(0, 4)}… (${value.length} chars)`;
}

const SECRETish_KEY = /(token|secret|api[-_]?key|apikey|password|authorization|bearer)/i;

export function maskSecrets<T>(value: T): T {
  const walk = (v: any, key?: string): any => {
    if (typeof v === "string") {
      if (key && SECRETish_KEY.test(key) && v.length >= 8 && !v.includes("{{")) return mask(v);
      return v.replace(/\b(Bearer\s+)[A-Za-z0-9\-_.]{12,}/gi, (_, p) => `${p}[masked]`);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    return v;
  };
  return walk(value);
}
