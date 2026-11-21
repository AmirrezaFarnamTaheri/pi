// The words hints use for the reader's device: "tap" on a touch screen, "click" with a mouse, both on a touch laptop;
// Cmd and Option on Apple's platforms, Ctrl and Alt on Windows and Linux.
import { useSyncExternalStore } from "react";
import { type PointerKind, pointerKind } from "../runtime/pointer-hints.ts";

export { type PointerKind, pointerKind, pressVerb } from "../runtime/pointer-hints.ts";

const COARSE = "(any-pointer: coarse)";
const FINE = "(any-pointer: fine)";

/** `pointerKind()`, re-rendering when it changes (a tablet's keyboard with a trackpad attached or taken off). */
export function usePointerKind(): PointerKind {
	return useSyncExternalStore(subscribePointerKind, pointerKind);
}

function subscribePointerKind(onChange: () => void): () => void {
	const queries = [matchMedia(COARSE), matchMedia(FINE)];
	for (const query of queries) query.addEventListener("change", onChange);
	return () => {
		for (const query of queries) query.removeEventListener("change", onChange);
	};
}

/** The verb for what opens more choices (`useLongPress` and `contextmenu`): "long-press", "right-click" or both. */
export function moreVerb(kind: PointerKind): string {
	return kind === "touch" ? "long-press" : kind === "mouse" ? "right-click" : "right-click or long-press";
}

/** `text` with its first letter upper case, for a hint verb that starts a sentence. */
export function upperFirst(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Whether the platform is Apple's (macOS, iOS, iPadOS): Cmd is the primary modifier there, Ctrl elsewhere. */
export const APPLE = /Mac|iPhone|iPad/.test(navigator.platform);

/** A key with the primary modifier, as the platform writes it: "⌘K" on Apple's, "Ctrl+K" on Windows and Linux. */
export function primaryChord(key: string): string {
	return APPLE ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}

/** The Alt key's label: "⌥" (Option) on Apple's keyboards, "Alt" elsewhere. */
export const ALT_KEY = APPLE ? "⌥" : "Alt";
