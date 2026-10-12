import { z } from "zod";

import { multiplyBasisPointsFloor } from "./money.js";

const nonnegativeMinorSchema = z.string().regex(/^(0|[1-9]\d*)$/);

export const cashPeriodSchema = z.strictObject({
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    evidenceReference: z.string().min(1),
    reconciliationStatus: z.enum(["SYNTHETIC_RECONCILED", "PREVIEW_UNRECONCILED"]),
    eligibleReceiptsMinor: nonnegativeMinorSchema,
    operatingExpensesMinor: nonnegativeMinorSchema,
    taxesMinor: nonnegativeMinorSchema,
    debtServiceMinor: nonnegativeMinorSchema,
    reserveContributionMinor: nonnegativeMinorSchema,
    excludedItemsMinor: nonnegativeMinorSchema,
});

export type CashPeriod = z.infer<typeof cashPeriodSchema>;

export type CashCalculation = Readonly<{
    formulaVersion: "sample-distributable-cash-v1";
    definedDistributableCashMinor: bigint;
    distributionPoolMinor: bigint;
    rounding: "floor-minor-unit";
}>;

export function calculateCashPeriod(input: CashPeriod, participationBasisPoints: number): CashCalculation {
    const period = cashPeriodSchema.parse(input);
    const definedDistributableCashMinor =
        BigInt(period.eligibleReceiptsMinor) -
        BigInt(period.operatingExpensesMinor) -
        BigInt(period.taxesMinor) -
        BigInt(period.debtServiceMinor) -
        BigInt(period.reserveContributionMinor) -
        BigInt(period.excludedItemsMinor);

    return {
        formulaVersion: "sample-distributable-cash-v1",
        definedDistributableCashMinor,
        distributionPoolMinor: multiplyBasisPointsFloor(
            definedDistributableCashMinor > 0n ? definedDistributableCashMinor : 0n,
            participationBasisPoints,
        ),
        rounding: "floor-minor-unit",
    };
}
