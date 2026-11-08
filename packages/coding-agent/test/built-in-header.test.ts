import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { BuiltInHeader, ExpandableText } from "../src/modes/interactive/components/built-in-header.ts";

describe("built-in header component", () => {
	it("updates the rendered text when expanded", () => {
		const text = new ExpandableText(() => "collapsed", () => "expanded");
		expect(text.render(30).join(" ")).toContain("collapsed");
		text.setExpanded(true);
		expect(text.render(30).join(" ")).toContain("expanded");
	});

	it("only handles logo clicks inside the logo target", () => {
		const header = new BuiltInHeader(() => "pi", () => "pi");
		const selections: Array<[number, number]> = [];
		header.onLogoClick = (column, row) => selections.push([column, row]);
		const event = { type: "click", x: 2, y: 1, screenX: 12, screenY: 21 } as TuiMouseEvent;
		expect(header.handleMouse(event)).toEqual({ handled: true });
		expect(selections).toEqual([[11, 20]]);
		expect(header.handleMouse({ ...event, x: 8 })).toBeUndefined();
	});
});
