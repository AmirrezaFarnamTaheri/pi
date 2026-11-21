// A device's pointer wording, safe to import in a Node worker without loading React or browser JSX.
export type PointerKind = "touch" | "mouse" | "both";

export function pointerKind(): PointerKind {
	if (typeof matchMedia !== "function" || !matchMedia("(any-pointer: coarse)").matches) return "mouse";
	return matchMedia("(any-pointer: fine)").matches ? "both" : "touch";
}

export function pressVerb(kind: PointerKind): string {
	return kind === "touch" ? "tap" : kind === "mouse" ? "click" : "click or tap";
}
