import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { buildSessionProjection, estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";

type Messages = ReturnType<typeof buildSessionProjection>["messages"];
/** Pi character estimates, corrected by recorded input usage where available. */
export const providerScale = (_provider?: string) => 1;
export const textTokens = (text: string, scale: number) => Math.ceil(text.length / 4 * scale);
export const messageTokens = (messages: Messages, scale: number) => Math.ceil(messages.reduce((sum, message) => sum + estimateTokens(message), 0) * scale);
export const prefixTokens = (messages: Messages, scale: number) => textTokens(getCurrentSystemPrompt(messages) + JSON.stringify(getCurrentTools(messages)), scale);

/** The receipt prices the previous INPUT, not its output (which can include hidden reasoning).
 * Add visible response/tool/user growth at the provider rate. Never reuse an input anchor across
 * compaction, context edits or a model switch: its source projection no longer describes this request.
 * Keep the receipt as an additive anchor, not a slice multiplier: SDK overhead and hidden SDK
 * compaction must not make ordinary retained text arbitrarily cheap or expensive.
 */
export function contextTokens(branch: SessionEntry[], provider?: string, model?: string) {
	const scale = providerScale(provider), messages = buildSessionProjection(branch).messages;
	const prefix = prefixTokens(messages, scale);
	const estimated = messageTokens(messages.filter(message => message.role !== "system"), scale) + prefix;
	const result = (input: number) => ({ input: Math.max(0, input), conversation: Math.max(0, input - prefix) });
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "compaction" || entry.type === "context_edit") break;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		if (message.provider !== provider || message.model !== model) break;
		const input = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		if (message.stopReason === "error" || message.stopReason === "aborted" || !Number.isFinite(input) || input <= 0) continue;
		const previous = buildSessionProjection(branch.slice(0, index)).messages;
		const previousInput = messageTokens(previous.filter(message => message.role !== "system"), scale) + prefixTokens(previous, scale);
		return result(estimated + input - previousInput);
	}
	return result(estimated);
}
export const conversationTokens = (branch: SessionEntry[], provider?: string, model?: string) => contextTokens(branch, provider, model).conversation;
