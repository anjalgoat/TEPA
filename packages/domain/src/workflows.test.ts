import { describe, expect, it } from "vitest";

import { assertTransition, canTransition } from "./workflows.js";

describe("workflow transitions", () => {
    it("allows each canonical start", () => {
        expect(canTransition("offering", "DRAFT", "REVIEW")).toBe(true);
        expect(canTransition("eligibility", "NOT_STARTED", "PENDING")).toBe(true);
        expect(canTransition("subscription", "DRAFT", "ACKNOWLEDGED")).toBe(true);
        expect(canTransition("distribution", "DRAFT", "RECONCILED")).toBe(true);
        expect(canTransition("buyback", "DRAFT", "APPRAISED")).toBe(true);
        expect(canTransition("acquisition", "DRAFT", "EVIDENCE_REVIEW")).toBe(true);
    });

    it("rejects skips, replay, and terminal-state changes", () => {
        expect(() => assertTransition("offering", "DRAFT", "SUBSCRIPTION_OPEN")).toThrow();
        expect(() => assertTransition("distribution", "APPROVED", "APPROVED")).toThrow();
        expect(() => assertTransition("acquisition", "FINALIZED", "DRAFT")).toThrow();
    });

    it("has explicit expiry, rejection, cancellation, and reconciliation states", () => {
        expect(canTransition("offering", "SUBSCRIPTION_OPEN", "EXPIRED")).toBe(true);
        expect(canTransition("eligibility", "PENDING", "REJECTED")).toBe(true);
        expect(canTransition("buyback", "OPEN", "CANCELLED")).toBe(true);
        expect(canTransition("subscription", "MINTED", "RECONCILIATION_REQUIRED")).toBe(true);
    });
});
