import { describe, expect, it } from "vitest";
import { walletErrorMessage } from "./walletFeedback.js";

describe("wallet action feedback", () => {
    it("does not describe a declined transaction as submitted", () => {
        expect(walletErrorMessage({ code: 4001, message: "User rejected" }, "Failed")).toContain(
            "No transaction or signature was submitted",
        );
    });

    it("explains pending and disconnected wallet requests", () => {
        expect(walletErrorMessage({ code: -32002 }, "Failed")).toContain("already open");
        expect(walletErrorMessage({ code: 4901 }, "Failed")).toContain("disconnected");
    });

    it("keeps actionable API errors and a safe fallback", () => {
        expect(walletErrorMessage(new Error("Receipt needs reconciliation"), "Failed")).toBe(
            "Receipt needs reconciliation",
        );
        expect(walletErrorMessage(null, "Could not record the claim")).toBe("Could not record the claim");
    });
});
