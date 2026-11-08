/** Require explicit, caller-verified consent before selecting the cross-account routing provider. */
export function assertAccountRotationConsent(provider: string, consent: boolean): void {
  if (provider === "account-profiles" && !consent) {
    throw new Error("Cross-account rotation can share the full transcript. Use /accounts to confirm and enable rotation.");
  }
}
