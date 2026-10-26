import type { BuiltinDriver } from "../provider.js";
import { CarrierFailure, postJson, usageOf } from "./http.js";
import { imageJson, JEV_BOX, JEV_IMAGES } from "../images.js";

/** Map a model name to a TypeSafe model id; the neutral `latest` alias is `jev-latest`. */
export const typesafeModel = (model: string) => (model === "latest" ? "jev-latest" : model);

export const typesafe: BuiltinDriver = {
  name: "typesafe",
  isConfigured: (env) => Boolean(env.TYPESAFE_API_KEY),
  assertConfigured(env) {
    if (!this.isConfigured(env)) throw new CarrierFailure("TYPESAFE_API_KEY is not set.");
  },
  create(env, options = {}) {
    this.assertConfigured(env);
    const key = env.TYPESAFE_API_KEY!;
    const baseURL = env.TYPESAFE_BASE_URL || "https://api.typesafe.ai";
    return {
      name: this.name,
      capabilities: (model) => model === "jev-1.14.0" ? JEV_BOX
        : ["latest", "jev-latest", "jev-preview", "jev-1.13.0"].includes(model) ? JEV_IMAGES : undefined,
      async ask({ state, questions, model, signal, images }) {
        const requested = typesafeModel(model);
        const body = await postJson(
          `${baseURL.replace(/\/$/, "")}/v1/systemone`,
          { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json", ...(images ? { "TypeSafe-Danger-Zone-Images": "true" } : {}) },
          imageJson({ state, questions, model: requested, ...(images ? { assets: Object.fromEntries(Object.entries(images).map(([id, asset]) => [id, { type: "image", format: asset.mediaType === "image/png" ? "png" : "jpeg", data_base64: asset.data_base64 }])) } : {}) }, images),
          { label: "TypeSafe API", signal, maxAttempts: options.maxAttempts },
        ) as Record<string, unknown> | null;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new CarrierFailure("TypeSafe API returned an invalid envelope (response omitted)");
        // Report the effective model the API answered with, not the alias we
        // requested. A present-but-malformed value passes through so shared
        // validation rejects it instead of masking it.
        return { answers: body.answers, usage: usageOf(body.usage), model: (Object.hasOwn(body, "model") ? body.model : requested) as string };
      },
    };
  },
};
