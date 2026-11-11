import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { ThemedText } from "./themed-text.ts";

export interface Expandable {
	setExpanded(expanded: boolean): void;
}

export class ExpandableText extends ThemedText implements Expandable {
	private readonly state: { expanded: boolean };

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		const state = { expanded };
		super(() => (state.expanded ? getExpandedText() : getCollapsedText()), paddingX, paddingY);
		this.state = state;
	}

	setExpanded(expanded: boolean): void {
		this.state.expanded = expanded;
		this.invalidate();
	}
}

/** The built-in header. Clicking its logo (the first two lines, after one column of padding) plays an easter egg. */
export class BuiltInHeader extends ExpandableText {
	onLogoClick: ((column: number, row: number) => void) | undefined;

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.y > 1 || event.x < 1 || event.x > 4 || !this.onLogoClick) return undefined;
		this.onLogoClick(event.screenX - event.x + 1, event.screenY - event.y);
		return { handled: true };
	}
}
