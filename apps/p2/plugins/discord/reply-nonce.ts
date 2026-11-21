import { createHash } from "node:crypto";

/** Stable 25-character Discord idempotency key for one message's reply chunk. */
export function replyNonce(messageId: string, chunkIndex: number): string {
	if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new Error("Invalid reply chunk index");
	return createHash("sha256").update(`pi-discord-reply:${messageId}:${chunkIndex}`).digest("hex").slice(0, 25);
}
