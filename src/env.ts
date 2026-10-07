import type { Env } from "./provider.js";

const LEGACY = "JEV_";
const CURRENT = "DISCERN_";

export interface NormalizedEnv {
  /** The input with every legacy JEV_<X> value copied to DISCERN_<X> when that is unset. */
  env: Env;
  /** Legacy JEV_<X> names that were set, sorted, for a deprecation warning. Never values. */
  legacy: string[];
}

/**
 * Discern 1.x reads every DISCERN_<X> variable from its legacy JEV_<X> name
 * when the new name is unset or empty. Empty strings count as unset, because
 * MCP clients often pass "" for variables they do not configure. Two
 * non-empty, different values are a configuration error that names both
 * variables but never their values. JEV_ names stop working in 2.0.
 */
export function normalizeDiscernEnv(env: Env): NormalizedEnv {
  const out: Env = { ...env };
  const legacy: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(LEGACY) || name.length === LEGACY.length || value === undefined || value === "") continue;
    legacy.push(name);
    const current = CURRENT + name.slice(LEGACY.length);
    const existing = env[current];
    if (existing === undefined || existing === "") out[current] = value;
    else if (existing !== value) throw new Error(`${current} and ${name} are both set to different values; unset ${name}.`);
  }
  return { env: out, legacy: legacy.sort() };
}
