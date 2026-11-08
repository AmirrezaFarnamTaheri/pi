import { describe, expect, it } from "vitest";
import { waitForCollected } from "./memory-helpers.ts";

describe("bounded WeakRef collection", () => {
	it("never reports a collection when the target remains strongly referenced", async () => {
		const retained = { state: "reachable" };
		const reference = new WeakRef(retained);
		expect(await waitForCollected([reference], 3)).toBe(false);
		expect(reference.deref()).toBe(retained);
	});

	it("can observe collection after the creating closure releases its target", async () => {
		const reference = (() => {
			const released = { state: "released" };
			return new WeakRef(released);
		})();
		expect(await waitForCollected([reference])).toBe(true);
	});
});
