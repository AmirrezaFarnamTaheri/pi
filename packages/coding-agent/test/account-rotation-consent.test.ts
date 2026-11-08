import { describe, expect, it } from "vitest";
import { assertAccountRotationConsent } from "../src/core/account-rotation-consent.ts";

describe("cross-account model selection requires opt-in", () => {
  it("allows ordinary provider models and explicitly approved account rotation", () => {
    expect(() => assertAccountRotationConsent("anthropic", false)).not.toThrow();
    expect(() => assertAccountRotationConsent("account-profiles", true)).not.toThrow();
  });

  it("refuses implicit selection through model cycling, /model or extensions", () => {
    expect(() => assertAccountRotationConsent("account-profiles", false))
      .toThrow(/share.*transcript|consent/i);
  });
});
