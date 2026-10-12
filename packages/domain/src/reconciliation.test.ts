import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildFinancialReview, financialFixtureSchema } from "./reconciliation.js";

function fixture(version: 1 | 2) {
    const file = new URL(
        `../../../data/fixtures/financials/reconciliation.v${version}.json`,
        import.meta.url,
    );
    return financialFixtureSchema.parse(JSON.parse(readFileSync(file, "utf8")) as unknown);
}

describe("financial reconciliation", () => {
    it("traces every monthly cash line to a source and identifies three review cases", () => {
        const input = fixture(1);
        const review = buildFinancialReview(input.rows, input.metrics, 1_000);
        expect(review.periods).toHaveLength(12);
        expect(review.matches).toHaveLength(24);
        expect(review.issues.map((issue) => issue.caseKey)).toEqual([
            "BANK_MISMATCH:2025-04",
            "LEDGER_MISMATCH:2025-08",
            "RELATED_PARTY:expense-operating:2025-09",
        ]);
        expect(review.periods[0]?.lines.receipts.sourceRefs).toEqual(["processor:2025-01"]);
        expect(review.annual).toEqual({
            definedDistributableCashMinor: input.expectedAnnualDefinedCashMinor,
            distributionPoolMinor: input.expectedAnnualPoolMinor,
        });
    });

    it("a revised operating row changes the exact preview", () => {
        const before = fixture(1);
        const after = fixture(2);
        const oldReview = buildFinancialReview(before.rows, before.metrics, 1_000);
        const newReview = buildFinancialReview(after.rows, after.metrics, 1_000);
        expect(
            BigInt(oldReview.annual.distributionPoolMinor) - BigInt(newReview.annual.distributionPoolMinor),
        ).toBe(1_000n);
        expect(newReview.annual.definedDistributableCashMinor).toBe(after.expectedAnnualDefinedCashMinor);
    });

    it("rejects incomplete, duplicate, and invalid source rows", () => {
        const input = fixture(1);
        expect(() => buildFinancialReview(input.rows.slice(1), input.metrics, 1_000)).toThrow(
            "Missing or duplicate",
        );
        expect(() => buildFinancialReview([...input.rows, input.rows[0]!], input.metrics, 1_000)).toThrow(
            "Duplicate source",
        );
        const invalid = input.rows.map((row, index) => (index === 0 ? { ...row, amountMinor: "-1" } : row));
        expect(() => buildFinancialReview(invalid, input.metrics, 1_000)).toThrow();
    });
});
