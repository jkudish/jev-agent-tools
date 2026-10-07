import type { Env } from "./provider.js";

const LEGACY = "JEV_";
const CURRENT = "DISCERN_";

/**
 * The variables this package reads, as suffixes after DISCERN_ (or the legacy
 * JEV_). Consumers append their own names; a suffix ending in "_" names a
 * prefix family, such as "PASSWORD_" for every DISCERN_PASSWORD_* variable.
 */
export const DISCERN_ENV_NAMES: readonly string[] = Object.freeze([
  "PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_BASE_URL",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_BASE_URL",
  "VERCEL_ZERO_DATA_RETENTION",
  "API_KEY",
  "API_BASE_URL",
]);

export interface NormalizedEnv {
  /** The input with every listed legacy JEV_<X> value copied to DISCERN_<X> when that is unset. */
  env: Env;
  /** Listed legacy JEV_<X> names that were set, sorted, for a deprecation warning. Never values. */
  legacy: string[];
}

const listed = (suffix: string, names: readonly string[]) =>
  names.some((name) => (name.endsWith("_") ? suffix.startsWith(name) && suffix.length > name.length : suffix === name));

/**
 * Discern 1.x reads each listed DISCERN_<X> variable from its legacy JEV_<X>
 * name when the new name is unset or empty. Only listed names are aliased, so
 * unrelated JEV_* variables are left alone. Empty strings count as unset,
 * because MCP clients often pass "" for variables they do not configure. Two
 * non-empty, different values are a configuration error that names both
 * variables but never their values. Returns a copy; the input is not changed.
 * JEV_ names stop working in 2.0.
 */
export function normalizeDiscernEnv(env: Env, names: readonly string[] = DISCERN_ENV_NAMES): NormalizedEnv {
  const out: Env = { ...env };
  const legacy: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(LEGACY) || value === undefined || value === "") continue;
    const suffix = name.slice(LEGACY.length);
    if (!listed(suffix, names)) continue;
    legacy.push(name);
    const current = CURRENT + suffix;
    const existing = env[current];
    if (existing === undefined || existing === "") out[current] = value;
    else if (existing !== value) throw new Error(`${current} and ${name} are both set to different values; unset ${name}.`);
  }
  return { env: out, legacy: legacy.sort() };
}
