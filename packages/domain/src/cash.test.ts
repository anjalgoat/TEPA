import { describe, expect, it } from "vitest";

import { calculateCashPeriod } from "./cash.js";

const input = {
    period: "2026-01",
    evidenceReference: "synthetic:2026-01",
    reconciliationStatus: "SYNTHETIC_RECONCILED",
    eligibleReceiptsMinor: "10000",
    operatingExpensesMinor: "5000",
    taxesMinor: "500",
    debtServiceMinor: "1000",
    reserveContributionMinor: "1000",
    excludedItemsMinor: "1",
} as const;

describe("sample distributable cash", () => {
    it("calculates the exact defined cash and floor-rounded pool", () => {
        expect(calculateCashPeriod(input, 1_000)).toEqual({
            formulaVersion: "sample-distributable-cash-v1",
            definedDistributableCashMinor: 2499n,
            distributionPoolMinor: 249n,
            rounding: "floor-minor-unit",
        });
    });

    it("clamps a negative cash base to a zero pool without hiding the negative result", () => {
        const result = calculateCashPeriod({ ...input, operatingExpensesMinor: "20000" }, 1_000);
        expect(result.definedDistributableCashMinor).toBeLessThan(0n);
        expect(result.distributionPoolMinor).toBe(0n);
    });

    it("rejects negative source categories", () => {
        expect(() => calculateCashPeriod({ ...input, taxesMinor: "-1" }, 1_000)).toThrow();
    });

    it("rejects unexpected source fields", () => {
        const invalid = { ...input, hiddenAdjustmentMinor: "100" };
        expect(() => calculateCashPeriod(invalid, 1_000)).toThrow();
    });
});
