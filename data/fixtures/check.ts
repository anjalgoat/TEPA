import { readFile } from "node:fs/promises";
import { z } from "zod";

import {
    buildFinancialReview,
    calculateCashPeriod,
    cashPeriodSchema,
    financialFixtureSchema,
    offeringSchema,
    prototypeTermsSchema,
    appraisalSchema,
    tenderSchema,
    acquisitionWaterfallSchema,
    calculateIndicativeValue,
    allocateBuyback,
    calculateAcquisition,
} from "../../packages/domain/src/index.js";

const cashFixtureSchema = z.strictObject({
    schemaVersion: z.literal(1),
    fictional: z.literal(true),
    formulaVersion: z.literal("sample-distributable-cash-v1"),
    currency: z.literal("USD"),
    decimals: z.literal(2),
    participationBasisPoints: z.literal(1_000),
    periods: z
        .array(
            cashPeriodSchema.extend({
                expectedDefinedCashMinor: z.string().regex(/^(0|[1-9]\d*|-[1-9]\d*)$/),
                expectedPoolMinor: z.string().regex(/^(0|[1-9]\d*)$/),
            }),
        )
        .length(12),
    expectedAnnualDefinedCashMinor: z.string().regex(/^(0|[1-9]\d*|-[1-9]\d*)$/),
    expectedAnnualPoolMinor: z.string().regex(/^(0|[1-9]\d*)$/),
});

const holdersFixtureSchema = z.strictObject({
    schemaVersion: z.literal(1),
    fictional: z.literal(true),
    allocationStatus: z.literal("SAMPLE_ONLY_NOT_ISSUED"),
    holders: z
        .array(
            z.strictObject({
                holderRef: z.string().regex(/^synthetic-holder-[a-z]$/),
                illustrativeUnits: z.number().int().positive(),
            }),
        )
        .length(2),
});

async function readJson(relativePath: string): Promise<unknown> {
    return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8")) as unknown;
}

async function main(): Promise<void> {
    const offering = offeringSchema.parse(await readJson("issuer/offering.json"));
    const holders = holdersFixtureSchema.parse(await readJson("investors/holders.v1.json"));
    const terms = prototypeTermsSchema.parse(await readJson("issuer/terms.v1.json"));
    if (
        terms.unitCount !== offering.unitCount ||
        terms.participationBasisPoints !== offering.participationBasisPoints
    )
        throw new Error("Terms and offering fixture disagree");
    if (
        new Set(holders.holders.map((holder) => holder.holderRef)).size !== 2 ||
        holders.holders.reduce((sum, holder) => sum + holder.illustrativeUnits, 0) !== offering.unitCount
    ) {
        throw new Error("Illustrative holder units must uniquely account for the 1,000-unit sample supply");
    }
    const fixture = cashFixtureSchema.parse(await readJson("financials/cash-preview.v1.json"));
    const periods = fixture.periods.map((period) => period.period);
    if (
        new Set(periods).size !== 12 ||
        periods.some((period, index) => period !== `2025-${String(index + 1).padStart(2, "0")}`)
    ) {
        throw new Error("Fixture must contain each month of 2025 exactly once and in order");
    }

    let annualCash = 0n;
    let annualPool = 0n;
    for (const period of fixture.periods) {
        const { expectedDefinedCashMinor, expectedPoolMinor, ...cashInput } = period;
        const result = calculateCashPeriod(cashInput, fixture.participationBasisPoints);
        if (
            result.definedDistributableCashMinor !== BigInt(expectedDefinedCashMinor) ||
            result.distributionPoolMinor !== BigInt(expectedPoolMinor)
        ) {
            throw new Error(`Cash fixture expectation failed for ${period.period}`);
        }
        annualCash += result.definedDistributableCashMinor;
        annualPool += result.distributionPoolMinor;
    }
    if (
        annualCash !== BigInt(fixture.expectedAnnualDefinedCashMinor) ||
        annualPool !== BigInt(fixture.expectedAnnualPoolMinor)
    ) {
        throw new Error("Annual cash fixture expectation failed");
    }
    const financialVersions = await Promise.all(
        [1, 2].map(async (version) => {
            const parsed = financialFixtureSchema.parse(
                await readJson(`financials/reconciliation.v${version}.json`),
            );
            if (parsed.fixtureVersion !== version)
                throw new Error(`Financial fixture version mismatch: ${version}`);
            const review = buildFinancialReview(
                parsed.rows,
                parsed.metrics,
                offering.participationBasisPoints,
            );
            if (
                review.annual.definedDistributableCashMinor !== parsed.expectedAnnualDefinedCashMinor ||
                review.annual.distributionPoolMinor !== parsed.expectedAnnualPoolMinor
            ) {
                throw new Error(`Financial reconciliation fixture expectation failed: v${version}`);
            }
            return parsed;
        }),
    );
    const [original, revised] = financialVersions;
    if (!original || !revised) throw new Error("Both financial fixture versions are required");
    const changedRows = revised.rows.filter(
        (row, index) => JSON.stringify(row) !== JSON.stringify(original.rows[index]),
    );
    if (changedRows.length !== 1 || changedRows[0]?.sourceRef !== "expense-operating:2025-01") {
        throw new Error("Revised fixture must change exactly one operating expense row");
    }
    const settlement = z
        .strictObject({
            schemaVersion: z.literal(1),
            fictional: z.literal(true),
            appraisal: appraisalSchema,
            expectedIndicativeUnitUsdMinor: z.string(),
            buyback: z.strictObject({
                budgetUsdMinor: z.string(),
                bindingUnitPriceUsdMinor: z.string(),
                tenders: z.array(tenderSchema).length(2),
                expectedAcceptedUnits: z.string(),
                expectedPayableUsdMinor: z.string(),
            }),
            acquisition: acquisitionWaterfallSchema.extend({ expectedSettlementPoolUsdMinor: z.string() }),
        })
        .parse(await readJson("settlement/sample.v1.json"));
    const indicative = calculateIndicativeValue(settlement.appraisal);
    if (
        indicative.indicativeUnitUsdMinor !== settlement.expectedIndicativeUnitUsdMinor ||
        settlement.appraisal.outstandingEligibleUnits !== String(offering.unitCount)
    )
        throw new Error("Sample appraisal fixture does not match the offering");
    const buyback = allocateBuyback(
        BigInt(settlement.buyback.budgetUsdMinor),
        BigInt(settlement.buyback.bindingUnitPriceUsdMinor),
        settlement.buyback.tenders,
    );
    if (
        buyback.acceptedUnits !== settlement.buyback.expectedAcceptedUnits ||
        buyback.payableUsdMinor !== settlement.buyback.expectedPayableUsdMinor
    )
        throw new Error("Sample buyback fixture allocation changed");
    const remaining = holders.holders.map((holder) => ({
        holderRef: holder.holderRef,
        walletAddress: holder.holderRef.endsWith("-a")
            ? "0x0000000000000000000000000000000000000001"
            : "0x0000000000000000000000000000000000000002",
        eligibleUnits: String(
            holder.illustrativeUnits -
                Number(
                    buyback.allocations.find((row) => row.holderRef === holder.holderRef)?.acceptedUnits ??
                        "0",
                ),
        ),
    }));
    const { expectedSettlementPoolUsdMinor, ...waterfall } = settlement.acquisition;
    const acquisition = calculateAcquisition(waterfall, remaining);
    if (
        acquisition.settlementPoolUsdMinor !== expectedSettlementPoolUsdMinor ||
        acquisition.allocation.totalEligibleUnits !== "750"
    )
        throw new Error("Sample acquisition fixture does not use post-buyback units");
    console.log(
        "Validated offering, two illustrative holders, 12 cash periods, financial versions 1 and 2, and Phase 4 settlement sample",
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Fixture validation failed");
    process.exitCode = 1;
});
