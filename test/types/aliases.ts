// Compile-only check: the Discern type names are exported, and the legacy Jev
// names still compile as aliases of them through 1.x.
import type { DiscernAnswer, DiscernTransport, DiscernTransportInput, DiscernTransportReply, JevAnswer, JevTransport, JevTransportInput, JevTransportReply } from "../../src/index.js";
import { image, type DiscernImage, type DiscernCapabilities, type RejectionCode } from "../../src/index.js";

const reply: DiscernTransportReply = { answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, model: "m" };
const transport: DiscernTransport = { name: "fixture", ask: async (_input: DiscernTransportInput) => reply };
const legacy: JevTransport = transport;
const back: DiscernTransport = legacy;
const legacyInput: JevTransportInput = { state: null, questions: {}, model: "m", signal: new AbortController().signal };
const legacyReply: JevTransportReply = reply;
const answer: DiscernAnswer = { type: "noul", noul: 0.5 };
const legacyAnswer: JevAnswer = answer;
export { back, legacyInput, legacyReply, legacyAnswer };

const photo: DiscernImage = image(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
const box: DiscernAnswer = { type: "box", box: { top: 0.13, bottom: 0.72, left: 0.61, right: 0.89 }, confidence: null };
const capabilities: DiscernCapabilities = { images: "state", box: false, maxImages: 1 };
const rejection: RejectionCode = "unsupported_feature";
export { photo, box, capabilities, rejection };
