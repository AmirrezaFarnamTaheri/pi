// Request validation as Pi Mobile does it: unknown models, unsupported thinking levels, blank messages; a single
// configured field still updates the session's catalog entry.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { expectChord, type Fixture, holdIn, startFixture, until } from "./helpers.ts";

describe("validation (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let session: Session;
	let chat: RefIn<typeof Chat, "participant">;
	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
		session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
	});
	after(async () => {
		await fixture?.close();
	});

	it("rejects unknown levels and clamps unsupported model-specific efforts when creating", async () => {
		await assert.rejects(
			sessions.create(
				{ cwd: fixture.workspace, model: { provider: "faux", modelId: "missing" } },
				BACKGROUND_CONTEXT,
			),
			/Unknown model/,
		);
		await expectChord(
			sessions.create({ cwd: fixture.workspace, thinkingLevel: "extreme" }, BACKGROUND_CONTEXT),
			"invalid",
		);
		const created = await sessions.create({ cwd: fixture.workspace, thinkingLevel: "low" }, BACKGROUND_CONTEXT);
		assert.equal(created.thinkingLevel, "off", "the fake model cannot perform reasoning");
	});

	it("refuses a blank message without attachments", async () => {
		await assert.rejects(chat.send({ text: "  \n ", requestId: "blank" }, BACKGROUND_CONTEXT), /Invalid content/);
		await assert.rejects(chat.send({ text: "", requestId: "empty" }, BACKGROUND_CONTEXT), /Invalid content/);
	});

	it("refuses unknown and unsupported thinking levels", async () => {
		await expectChord(chat.configure({ thinkingLevel: "extreme" }, BACKGROUND_CONTEXT), "invalid");
		await assert.rejects(
			chat.configure({ thinkingLevel: "minimal" }, BACKGROUND_CONTEXT),
			/Thinking level is not supported by the selected model/,
		);
	});

	it("publishes a real reasoning-level transition and preserves it on a model-only update", async () => {
		const reasoning = await startFixture({
			modelsConfig: { providers: { faux: { modelOverrides: { "faux-1": { reasoning: true } } } } },
		});
		try {
			const host = reasoning.browser();
			const catalog = await holdIn(host, Sessions, {}, "owner");
			const created = await catalog.create({ cwd: reasoning.workspace, thinkingLevel: "off" }, BACKGROUND_CONTEXT);
			const conversation = await holdIn(host, Chat, { session: created.id, conversation: 1 }, "participant");

			await until(
				catalog.sessions,
				(list) => list?.find((entry) => entry.id === created.id)?.thinkingLevel === "off",
			);
			await conversation.configure({ thinkingLevel: "low" }, BACKGROUND_CONTEXT);
			await until(
				catalog.sessions,
				(list) => list?.find((entry) => entry.id === created.id)?.thinkingLevel === "low",
			);

			await conversation.configure({ model: { provider: "faux", modelId: "faux-1" } }, BACKGROUND_CONTEXT);
			const updated = await until(
				catalog.sessions,
				(list) => list?.find((entry) => entry.id === created.id)?.thinkingLevel === "low",
			);
			assert.equal(updated?.find((entry) => entry.id === created.id)?.thinkingLevel, "low");
		} finally {
			await reasoning.close();
		}
	});
});
