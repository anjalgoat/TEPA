import { z } from "zod";
import { allocateDistribution, distributionHolderSchema } from "./distribution.js";
import { basisPoints, multiplyBasisPointsFloor } from "./money.js";

const unsigned = z.string().regex(/^(0|[1-9]\d*)$/);
const positive = z.string().regex(/^[1-9]\d*$/);

export const appraisalSchema = z.strictObject({
    appraisedEquityUsdMinor: unsigned,
    participationBasisPoints: z.number().int().min(1).max(10_000),
    outstandingEligibleUnits: positive,
    valuationDate: z.iso.date(),
    methodology: z.string().trim().min(12),
    evidenceRef: z.string().trim().min(1),
    assumptions: z.strictObject({
        cashAndDebt: z.string().trim().min(1),
        dilution: z.string().trim().min(1),
        pastDistributions: z.string().trim().min(1),
        tepaObligation: z.literal("BEFORE_TEPA_ALLOCATION"),
    }),
});
export type Appraisal = z.infer<typeof appraisalSchema>;

export function calculateIndicativeValue(input: Appraisal) {
    const appraisal = appraisalSchema.parse(input);
    const pool = multiplyBasisPointsFloor(
        BigInt(appraisal.appraisedEquityUsdMinor),
        appraisal.participationBasisPoints,
    );
    const units = BigInt(appraisal.outstandingEligibleUnits);
    return {
        formulaVersion: "indicative-before-tepa-v1" as const,
        poolUsdMinor: pool.toString(),
        indicativeUnitUsdMinor: (pool / units).toString(),
        unallocatedMinor: (pool % units).toString(),
        ...appraisal,
    };
}

export const tenderSchema = z.strictObject({
    submissionId: z.uuid(),
    holderRef: z.string().min(1),
    tenderedUnits: positive,
    holdingUnits: unsigned,
});
export type Tender = z.infer<typeof tenderSchema>;

export function allocateBuyback(
    budgetUsdMinor: bigint,
    bindingUnitPriceUsdMinor: bigint,
    input: readonly Tender[],
) {
    if (budgetUsdMinor < 0n || bindingUnitPriceUsdMinor <= 0n)
        throw new Error("Buyback needs a nonnegative budget and positive binding price");
    const tenders = z.array(tenderSchema).parse(input);
    const submissions = new Set<string>();
    const holders = new Set<string>();
    for (const tender of tenders) {
        if (submissions.has(tender.submissionId) || holders.has(tender.holderRef))
            throw new Error("Active tender submissions and holders must be unique");
        if (BigInt(tender.tenderedUnits) > BigInt(tender.holdingUnits))
            throw new Error("Tender exceeds current holdings");
        submissions.add(tender.submissionId);
        holders.add(tender.holderRef);
    }
    const totalTendered = tenders.reduce((sum, tender) => sum + BigInt(tender.tenderedUnits), 0n);
    const maxUnits = budgetUsdMinor / bindingUnitPriceUsdMinor;
    const acceptedTotal = totalTendered < maxUnits ? totalTendered : maxUnits;
    const rows = tenders.map((tender) => {
        const numerator = acceptedTotal * BigInt(tender.tenderedUnits);
        return {
            ...tender,
            accepted: totalTendered === 0n ? 0n : numerator / totalTendered,
            remainder: totalTendered === 0n ? 0n : numerator % totalTendered,
            roundingUnitAwarded: false,
        };
    });
    let residual = acceptedTotal - rows.reduce((sum, row) => sum + row.accepted, 0n);
    for (const row of [...rows].sort(
        (a, b) =>
            (a.remainder === b.remainder ? 0 : a.remainder > b.remainder ? -1 : 1) ||
            a.submissionId.localeCompare(b.submissionId),
    )) {
        if (residual === 0n) break;
        if (row.accepted >= BigInt(row.tenderedUnits)) continue;
        row.accepted += 1n;
        row.roundingUnitAwarded = true;
        residual -= 1n;
    }
    if (residual !== 0n) throw new Error("Buyback rounding failed");
    return {
        formulaVersion: "buyback-largest-remainder-v1" as const,
        budgetUsdMinor: budgetUsdMinor.toString(),
        bindingUnitPriceUsdMinor: bindingUnitPriceUsdMinor.toString(),
        maxUnits: maxUnits.toString(),
        totalTenderedUnits: totalTendered.toString(),
        acceptedUnits: acceptedTotal.toString(),
        payableUsdMinor: (acceptedTotal * bindingUnitPriceUsdMinor).toString(),
        unusedBudgetUsdMinor: (budgetUsdMinor - acceptedTotal * bindingUnitPriceUsdMinor).toString(),
        allocations: rows
            .sort((a, b) => a.submissionId.localeCompare(b.submissionId))
            .map((row) => ({
                submissionId: row.submissionId,
                holderRef: row.holderRef,
                tenderedUnits: row.tenderedUnits,
                holdingUnits: row.holdingUnits,
                acceptedUnits: row.accepted.toString(),
                rejectedUnits: (BigInt(row.tenderedUnits) - row.accepted).toString(),
                remainder: row.remainder.toString(),
                roundingUnitAwarded: row.roundingUnitAwarded,
            })),
    };
}

export const acquisitionWaterfallSchema = z.strictObject({
    grossConsiderationUsdMinor: unsigned,
    transactionCostsUsdMinor: unsigned,
    debtAndSeniorObligationsUsdMinor: unsigned,
    taxesAndRequiredReservesUsdMinor: unsigned,
    disclosedOtherDeductionsUsdMinor: unsigned,
    otherDeductionsDescription: z.string(),
    participationBasisPoints: z.number().int().min(1).max(10_000),
});
export type AcquisitionWaterfall = z.infer<typeof acquisitionWaterfallSchema>;

export function calculateAcquisition(
    input: AcquisitionWaterfall,
    holders: readonly z.infer<typeof distributionHolderSchema>[],
) {
    const value = acquisitionWaterfallSchema.parse(input);
    basisPoints(value.participationBasisPoints);
    if (BigInt(value.disclosedOtherDeductionsUsdMinor) > 0n && !value.otherDeductionsDescription.trim())
        throw new Error("Other deductions need a description");
    const deductions =
        BigInt(value.transactionCostsUsdMinor) +
        BigInt(value.debtAndSeniorObligationsUsdMinor) +
        BigInt(value.taxesAndRequiredReservesUsdMinor) +
        BigInt(value.disclosedOtherDeductionsUsdMinor);
    const net = BigInt(value.grossConsiderationUsdMinor) - deductions;
    const pool = multiplyBasisPointsFloor(net > 0n ? net : 0n, value.participationBasisPoints);
    return {
        formulaVersion: "acquisition-waterfall-v1" as const,
        ...value,
        totalDeductionsUsdMinor: deductions.toString(),
        definedNetProceedsUsdMinor: net.toString(),
        settlementPoolUsdMinor: pool.toString(),
        allocation: allocateDistribution(pool, holders),
    };
}
