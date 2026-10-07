// Compile-only check: the Discern type names are exported, and the legacy Jev
// names still compile as aliases of them through 1.x.
import type { DiscernAnswer, DiscernTransport, DiscernTransportInput, DiscernTransportReply, JevAnswer, JevTransport, JevTransportInput, JevTransportReply } from "../../src/index.js";

const reply: DiscernTransportReply = { answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, model: "m" };
const transport: DiscernTransport = { name: "fixture", ask: async (_input: DiscernTransportInput) => reply };
const legacy: JevTransport = transport;
const back: DiscernTransport = legacy;
const legacyInput: JevTransportInput = { state: null, questions: {}, model: "m", signal: new AbortController().signal };
const legacyReply: JevTransportReply = reply;
const answer: DiscernAnswer = { type: "noul", noul: 0.5 };
const legacyAnswer: JevAnswer = answer;
export { back, legacyInput, legacyReply, legacyAnswer };
