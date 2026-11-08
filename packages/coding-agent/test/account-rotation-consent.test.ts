import { describe, expect, it } from "vitest";
import { assertAccountRotationConsent, allowedCycleModels } from "../src/core/account-rotation-consent.ts";

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

describe("rotation consent is scoped to each session transcript", () => {
  it("permits an approved rotation only while the same session remains active", () => {
    expect(() => assertAccountRotationConsent("account-profiles", true, "session-1", "session-1")).not.toThrow();
    expect(() => assertAccountRotationConsent("account-profiles", true, "session-1", "session-2"))
      .toThrow(/consent/i);
  });
  it("cycles past an unconsented account group without trapping model navigation", () => {
    const models = [{ provider: "ordinary", id: "a" }, { provider: "account-profiles", id: "x" },
      { provider: "ordinary", id: "b" }];
    expect(allowedCycleModels(models, false).map((m) => m.id)).toEqual(["a", "b"]);
    expect(allowedCycleModels(models, true)).toEqual(models);
  });
});
