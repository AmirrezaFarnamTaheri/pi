/** Model rotation is a cross-account transmission of the current transcript. */
export function assertAccountRotationConsent(
	provider: string,
	consent: boolean,
	approvedSessionId?: string,
	currentSessionId?: string,
): void {
	if (provider !== "account-profiles") return;
	if (!consent || (currentSessionId !== undefined && approvedSessionId !== currentSessionId)) {
		throw new Error(
			"Cross-account rotation can share the full transcript; explicit consent is required for this session. Use /accounts to enable rotation.",
		);
	}
}

/** Account-group models are not navigation obstacles for people who did not opt in. */
export function allowedCycleModels<T extends { provider: string }>(
	models: readonly T[],
	hasCurrentSessionConsent: boolean,
): T[] {
	return hasCurrentSessionConsent ? [...models] : models.filter((model) => model.provider !== "account-profiles");
}
