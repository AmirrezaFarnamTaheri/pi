// A voice worker can use pointer wording without importing the JSX/React browser runtime.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pointerKind, pressVerb } from "../../src/runtime/pointer-hints.ts";

describe("pointer wording shared with voice", () => {
	it("uses mouse wording when matchMedia is unavailable on the server", () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
		try {
			Reflect.deleteProperty(globalThis, "matchMedia");
			assert.equal(pointerKind(), "mouse");
		} finally {
			if (descriptor) Object.defineProperty(globalThis, "matchMedia", descriptor);
		}
	});
	it("uses touch, mouse and hybrid verbs without loading the UI runtime", () => {
		for (const [coarse, fine, expected] of [
			[false, true, "mouse"],
			[true, false, "touch"],
			[true, true, "both"],
		] as const) {
			const descriptor = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
			try {
				Object.defineProperty(globalThis, "matchMedia", {
					configurable: true,
					value: (query: string) => ({ matches: query.includes("coarse") ? coarse : fine }),
				});
				assert.equal(pointerKind(), expected);
			} finally {
				if (descriptor) Object.defineProperty(globalThis, "matchMedia", descriptor);
				else Reflect.deleteProperty(globalThis, "matchMedia");
			}
		}
		assert.equal(pressVerb("touch"), "tap");
		assert.equal(pressVerb("mouse"), "click");
		assert.equal(pressVerb("both"), "click or tap");
	});
});
