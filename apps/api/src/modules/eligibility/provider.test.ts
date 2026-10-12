import { describe, expect, it } from "vitest";
import { mockEligibilityProvider } from "./provider.js";

describe("deterministic mock eligibility provider", () => {
    it("approves a passing fictional check", async () => {
        expect(
            await mockEligibilityProvider.assess({
                identity: "PASS",
                sanctions: "CLEAR",
                jurisdiction: "US",
            }),
        ).toMatchObject({ status: "APPROVED", policyVersion: "mock-eligibility-v1" });
    });
    it("rejects a sanctions hit and an identity failure", async () => {
        expect(
            (await mockEligibilityProvider.assess({ identity: "PASS", sanctions: "HIT", jurisdiction: "US" }))
                .status,
        ).toBe("REJECTED");
        expect(
            (
                await mockEligibilityProvider.assess({
                    identity: "FAIL",
                    sanctions: "CLEAR",
                    jurisdiction: "US",
                })
            ).status,
        ).toBe("REJECTED");
    });
});
