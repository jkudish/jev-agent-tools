import type { BuiltinDriver } from "../provider.js";

export const typesafe: BuiltinDriver = {
  name: "typesafe",
  isConfigured: (env) => Boolean(env.TYPESAFE_API_KEY),
  assertConfigured(env) {
    if (!this.isConfigured(env)) throw new Error("TYPESAFE_API_KEY is not set.");
  },
  create(env) {
    this.assertConfigured(env);
    const key = env.TYPESAFE_API_KEY!;
    const baseURL = env.TYPESAFE_BASE_URL || "https://api.typesafe.ai";
    return {
      name: this.name,
      async ask({ state, questions, model, signal }) {
        let response: { answers: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
        try {
          const wire = await fetch(`${baseURL.replace(/\/$/, "")}/v1/systemone`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ state, questions, model }),
            signal,
          });
          if (!wire.ok) throw { status: wire.status };
          response = await wire.json();
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          const status = (error as { status?: unknown }).status;
          throw new Error(`TypeSafe API ${typeof status === "number" ? `HTTP ${status}` : "request failed"} (response omitted)`);
        }
        const usage = response?.usage;
        if (usage !== undefined && (typeof usage !== "object" || usage === null || Array.isArray(usage))) {
          throw new Error("TypeSafe API invalid usage (response omitted)");
        }
        return {
          answers: response?.answers,
          usage: {
            input_tokens: usage && Object.hasOwn(usage, "input_tokens") ? usage.input_tokens as number : 0,
            output_tokens: usage && Object.hasOwn(usage, "output_tokens") ? usage.output_tokens as number : 0,
          },
          model,
        };
      },
    };
  },
};
