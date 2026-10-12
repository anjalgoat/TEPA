import { describe, expect, it } from "vitest";
import { allocateBuyback, calculateAcquisition, calculateIndicativeValue } from "./settlement.js";

const a = "0x0000000000000000000000000000000000000001";
const b = "0x0000000000000000000000000000000000000002";
const idA = "00000000-0000-4000-8000-000000000001";
const idB = "00000000-0000-4000-8000-000000000002";

describe("Phase 4 exact calculations", () => {
    it("keeps a sample appraisal informational and rounds its unit estimate down", () => {
        const result = calculateIndicativeValue({
            appraisedEquityUsdMinor: "200000001",
            participationBasisPoints: 1000,
            outstandingEligibleUnits: "1000",
            valuationDate: "2026-09-23",
            methodology: "Independent sample appraisal",
            evidenceRef: "fictional-appraisal-v1",
            assumptions: {
                cashAndDebt: "Included in adjusted equity value",
                dilution: "No new financing in this sample",
                pastDistributions: "Excluded from this appraisal",
                tepaObligation: "BEFORE_TEPA_ALLOCATION",
            },
        });
        expect(result.poolUsdMinor).toBe("20000000");
        expect(result.indicativeUnitUsdMinor).toBe("20000");
        expect(result.unallocatedMinor).toBe("0");
    });

    it("allocates an oversubscribed buyback by submission ID and preserves rejected units", () => {
        const result = allocateBuyback(500n, 100n, [
            { submissionId: idB, holderRef: "b", tenderedUnits: "3", holdingUnits: "4" },
            { submissionId: idA, holderRef: "a", tenderedUnits: "3", holdingUnits: "6" },
        ]);
        expect(result.maxUnits).toBe("5");
        expect(
            result.allocations.map((row) => [row.holderRef, row.acceptedUnits, row.rejectedUnits]),
        ).toEqual([
            ["a", "3", "0"],
            ["b", "2", "1"],
        ]);
        expect(result.payableUsdMinor).toBe("500");
        expect(() =>
            allocateBuyback(500n, 100n, [
                { submissionId: idA, holderRef: "a", tenderedUnits: "7", holdingUnits: "6" },
            ]),
        ).toThrow("holdings");
        expect(() => allocateBuyback(0n, 0n, [])).toThrow("positive");
    });

    it("uses remaining units for the acquisition waterfall and conserves cents", () => {
        const result = calculateAcquisition(
            {
                grossConsiderationUsdMinor: "10000",
                transactionCostsUsdMinor: "1000",
                debtAndSeniorObligationsUsdMinor: "1000",
                taxesAndRequiredReservesUsdMinor: "1000",
                disclosedOtherDeductionsUsdMinor: "0",
                otherDeductionsDescription: "",
                participationBasisPoints: 1000,
            },
            [
                { holderRef: "a", walletAddress: a, eligibleUnits: "3" },
                { holderRef: "b", walletAddress: b, eligibleUnits: "4" },
            ],
        );
        expect(result.definedNetProceedsUsdMinor).toBe("7000");
        expect(result.settlementPoolUsdMinor).toBe("700");
        expect(result.allocation.entitlements.map((row) => row.amountMinor)).toEqual(["300", "400"]);
        expect(
            calculateAcquisition(
                {
                    grossConsiderationUsdMinor: "1",
                    transactionCostsUsdMinor: "2",
                    debtAndSeniorObligationsUsdMinor: "0",
                    taxesAndRequiredReservesUsdMinor: "0",
                    disclosedOtherDeductionsUsdMinor: "0",
                    otherDeductionsDescription: "",
                    participationBasisPoints: 1000,
                },
                [],
            ).settlementPoolUsdMinor,
        ).toBe("0");
    });
});
