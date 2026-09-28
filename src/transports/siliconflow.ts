import type { BuiltinDriver } from "../provider.js";

export const siliconflow: BuiltinDriver = {
  name: "siliconflow",
  isConfigured: (env) => Boolean(env.SILICONFLOW_API_KEY),
  assertConfigured(env) {
    if (!this.isConfigured(env)) throw new Error("SILICONFLOW_API_KEY is not set.");
  },
  create(env) {
    this.assertConfigured(env);
    const key = env.SILICONFLOW_API_KEY!;
    return {
      name: this.name,
      async ask({ state, questions, model, signal }) {
        const effective = model === "jev-latest" ? "semif" : model;
        const response = await fetch("https://api.siliconflow.cn/v1/systemone", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: effective, state, questions }),
          signal,
        }).catch(() => {
          if (signal.aborted) throw signal.reason;
          throw new Error("SiliconFlow system one API HTTP unavailable (network error; 0 response bytes)");
        });
        const raw = await response.text().catch(() => {
          if (signal.aborted) throw signal.reason;
          throw new Error(`SiliconFlow system one API HTTP ${response.status} (body read error; 0 response bytes)`);
        });
        const bytes = Buffer.byteLength(raw);
        if (!response.ok) throw new Error(`SiliconFlow system one API HTTP ${response.status} (request failed; ${bytes} response bytes)`);
        let body: any;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new Error(`SiliconFlow system one API HTTP ${response.status} (invalid JSON; ${bytes} response bytes)`);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`SiliconFlow system one API HTTP ${response.status} (invalid envelope; ${bytes} response bytes)`);
        const usage = body.usage;
        if (usage !== undefined && (typeof usage !== "object" || usage === null || Array.isArray(usage))) {
          throw new Error(`SiliconFlow system one API HTTP ${response.status} (invalid usage; ${bytes} response bytes)`);
        }
        return {
          answers: body.answers,
          usage: {
            input_tokens: usage && Object.hasOwn(usage, "input_tokens") ? usage.input_tokens : 0,
            output_tokens: usage && Object.hasOwn(usage, "output_tokens") ? usage.output_tokens : 0,
          },
          model: typeof body.model === "string" && body.model ? body.model : effective,
        };
      },
    };
  },
};
