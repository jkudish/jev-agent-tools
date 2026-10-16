import { randomUUID } from "node:crypto";
import type { DiscernTransportInput } from "./provider.js";

const MiB = 1024 * 1024;
const brand: unique symbol = Symbol("DiscernImage");
/** Call-local PNG/JPEG bytes. Create with image(); never interpreted as a URL or path. */
export interface DiscernImage { readonly [brand]: true }
export interface ImageAsset {
  readonly mediaType: "image/png" | "image/jpeg";
  readonly data_base64: string;
}
/** Prepared by ask(), not a caller-supplied upload registry. References occur in state/questions. */
export type PreparedImages = Readonly<Record<string, ImageAsset>>;
export interface DiscernCapabilities {
  readonly images: "state" | "inline";
  readonly box: boolean;
  readonly maxImages: number;
  readonly maxQuestions?: number;
  readonly maxStateBytes?: number;
}
export const JEV_IMAGES: DiscernCapabilities = { images: "inline", box: false, maxImages: 4 };
export const JEV_BOX: DiscernCapabilities = { ...JEV_IMAGES, box: true };
export const STATE_IMAGES: DiscernCapabilities = { images: "state", box: false, maxImages: 4 };
const values = new WeakMap<object, { asset: ImageAsset; size: number }>();

export class ImageFailure extends TypeError {
  constructor(readonly code: "invalid_image" | "unsupported_feature", message: string) { super(message); }
}

/** Snapshots bytes. Throws TypeError for invalid/oversized input; ask() itself remains non-throwing. */
export function image(bytes: Uint8Array | ArrayBuffer): DiscernImage {
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new ImageFailure("invalid_image", "image() requires PNG/JPEG bytes");
  if (bytes.byteLength > 4 * MiB) throw new ImageFailure("invalid_image", "Image exceeds 4 MiB");
  const copy = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
  const mediaType = copy.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : copy.length >= 3 && copy[0] === 255 && copy[1] === 216 && copy[2] === 255 ? "image/jpeg" : null;
  if (!mediaType) throw new ImageFailure("invalid_image", "Image bytes must have a PNG or JPEG signature");
  const value = Object.freeze({ [brand]: true as const, toJSON() { throw new ImageFailure("invalid_image", "Use image values through ask(), not JSON.stringify"); } });
  values.set(value, { asset: Object.freeze({ mediaType, data_base64: copy.toString("base64") }), size: copy.length });
  return value;
}

/** Preserve text-only serialization. For image calls, clone a bounded JSON graph and replace branded values. */
export function prepareImages(input: DiscernTransportInput, capabilities?: DiscernCapabilities): DiscernTransportInput {
  const assets: [string, ImageAsset][] = [];
  const ids = new Map<object, string>();
  const stateIds = new Set<string>();
  const ancestors = new Set<object>();
  let inline = false;
  let nonJson = false;
  let size = 0;
  let nodes = 0;
  const walk = (value: unknown, inState: boolean, depth = 0): unknown => {
    if (value !== null && typeof value === "object" && values.has(value)) {
      const stored = values.get(value)!;
      let id = ids.get(value);
      if (!id) {
        id = randomUUID();
        ids.set(value, id);
        assets.push([id, stored.asset]);
        size += stored.size;
        if (ids.size > 4 || size > 8 * MiB) throw new ImageFailure("invalid_image", "Images exceed count or decoded-byte limits (4 images, 8 MiB total)");
      }
      if (inState) stateIds.add(id); else inline = true;
      return id;
    }
    if (++nodes > 100_000 || depth > 64) throw new ImageFailure("invalid_image", "Image request structure is too large or deep");
    if (value === null || typeof value !== "object") {
      if (["function", "symbol", "bigint"].includes(typeof value)) nonJson = true;
      return value;
    }
    const prototype = Object.getPrototypeOf(value);
    if ((!Array.isArray(value) && prototype !== null && prototype !== Object.prototype) || typeof (value as { toJSON?: unknown }).toJSON === "function") nonJson = true;
    if (ancestors.has(value)) throw new ImageFailure("invalid_image", "Image request must not contain cycles");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => walk(item, inState, depth + 1));
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, inState, depth + 1)]));
    } finally { ancestors.delete(value); }
  };
  const hasBox = Object.values(input.questions ?? {}).some((q) => q !== null && typeof q === "object" && (q as { type?: unknown }).type === "box");
  let state: unknown;
  let questions: Record<string, unknown>;
  try {
    state = walk(input.state, true);
    questions = walk(input.questions, false) as Record<string, unknown>;
  } catch (error) {
    // Ordinary text still uses the carrier's original JSON serialization and errors.
    // An image outside the walk bound cannot silently escape: its toJSON rejects.
    if (!assets.length && !hasBox) return { ...input, images: undefined };
    throw error;
  }
  if (!assets.length && !hasBox) return { ...input, images: undefined };
  if (nonJson) throw new ImageFailure("invalid_image", "Image requests require plain JSON state/questions, without custom serialization");
  if (!capabilities || (inline && capabilities.images !== "inline") || ids.size > capabilities.maxImages || (hasBox && !capabilities.box)) {
    throw new ImageFailure("unsupported_feature", "Selected provider/model does not support this image placement, image count, or Box; use a documented image-capable model (Box: TypeSafe jev-1.14.0 or OpenRouter typesafe/jev-1.14)");
  }
  if (hasBox && (ids.size !== 1 || stateIds.size !== 1 || inline)) throw new ImageFailure("invalid_image", "Box requires exactly one distinct image in state and no question images");
  if (capabilities.maxQuestions && Object.keys(questions).length > capabilities.maxQuestions) throw new ImageFailure("unsupported_feature", "Image request exceeds this route's question limit");
  if (capabilities.maxStateBytes && Buffer.byteLength(JSON.stringify(state)) > capabilities.maxStateBytes) throw new ImageFailure("invalid_image", "Image request exceeds this route's text-state limit");
  // Snapshot image-bearing state/questions before the first asynchronous send.
  return { ...input, state, questions, images: Object.freeze(Object.fromEntries(assets)) };
}

/** Bound the actual encoded carrier body, not just the original file lengths. */
export function imageJson(body: unknown, images?: PreparedImages): string {
  const json = JSON.stringify(body);
  if (images && Buffer.byteLength(json) > 13 * MiB) throw new ImageFailure("invalid_image", "Encoded image request exceeds 13 MiB");
  return json;
}

/** Native inline parts (OpenRouter/Jev) retain every nested image occurrence. */
export function inlineImages(value: unknown, images: PreparedImages): unknown {
  if (typeof value === "string" && Object.hasOwn(images, value)) {
    const asset = images[value];
    return { type: "image_url", image_url: { url: `data:${asset.mediaType};base64,${asset.data_base64}` } };
  }
  if (Array.isArray(value)) return value.map((item) => inlineImages(item, images));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inlineImages(item, images)]));
  return value;
}
