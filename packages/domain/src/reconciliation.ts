import { z } from "zod";

import { calculateCashPeriod } from "./cash.js";
import { basisPoints } from "./money.js";

export const financialRowSchema = z
    .strictObject({
        sourceRef: z.string().regex(/^[a-z-]+:20\d{2}-(0[1-9]|1[0-2])$/),
        sourceSystem: z.enum(["PROCESSOR", "BANK", "LEDGER", "EXPENSE", "DEBT"]),
        period: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
        category: z.enum(["RECEIPT", "OPERATING", "TAX", "RESERVE", "EXCLUDED", "DEBT_SERVICE"]),
        amountMinor: z.string().regex(/^(0|[1-9]\d*)$/),
        evidenceRef: z.string().startsWith("synthetic:"),
        relatedParty: z.boolean(),
    })
    .superRefine((row, context) => {
        const valid =
            row.sourceSystem === "EXPENSE"
                ? ["OPERATING", "TAX", "RESERVE", "EXCLUDED"].includes(row.category)
                : row.sourceSystem === "DEBT"
                  ? row.category === "DEBT_SERVICE"
                  : row.category === "RECEIPT";
        if (!valid)
            context.addIssue({
                code: "custom",
                message: "Invalid source/category pairing",
                path: ["category"],
            });
        if (row.sourceSystem !== "EXPENSE" && row.relatedParty) {
            context.addIssue({
                code: "custom",
                message: "Related-party flag belongs to expense rows",
                path: ["relatedParty"],
            });
        }
    });

export const customerMetricSchema = z.strictObject({
    sourceRef: z.string().regex(/^metric:20\d{2}-(0[1-9]|1[0-2])$/),
    period: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
    activeCustomers: z.number().int().nonnegative(),
    arrMinor: z.string().regex(/^(0|[1-9]\d*)$/),
    churnBasisPoints: z.number().int().min(0).max(10_000),
    evidenceRef: z.string().startsWith("synthetic:"),
});

export const financialFixtureSchema = z.strictObject({
    schemaVersion: z.literal(1),
    fictional: z.literal(true),
    fixtureVersion: z.union([z.literal(1), z.literal(2)]),
    issuerPublicId: z.literal("example-saas"),
    rows: z.array(financialRowSchema),
    metrics: z.array(customerMetricSchema),
    expectedAnnualDefinedCashMinor: z.string().regex(/^(0|[1-9]\d*|-[1-9]\d*)$/),
    expectedAnnualPoolMinor: z.string().regex(/^(0|[1-9]\d*)$/),
});

export type FinancialRow = z.infer<typeof financialRowSchema>;
export type CustomerMetric = z.infer<typeof customerMetricSchema>;
export type FinancialFixture = z.infer<typeof financialFixtureSchema>;

type ReconciliationIssue = Readonly<{
    caseKey: string;
    kind: "BANK_MISMATCH" | "LEDGER_MISMATCH" | "RELATED_PARTY";
    period: string;
    sourceRefs: string[];
    deltaMinor: string;
    suggestion: "REVIEW_TIMING" | "REVIEW_LEDGER" | "REVIEW_RELATED_PARTY";
}>;

type MoneyLine = Readonly<{ amountMinor: string; sourceRefs: string[] }>;

export type FinancialReview = Readonly<{
    formulaVersion: "sample-distributable-cash-v1";
    rounding: "floor-minor-unit-per-period";
    periods: ReadonlyArray<{
        period: string;
        lines: Record<"receipts" | "operating" | "tax" | "debt" | "reserve" | "excluded", MoneyLine>;
        definedDistributableCashMinor: string;
        distributionPoolMinor: string;
        customerMetricSourceRef: string;
    }>;
    annual: { definedDistributableCashMinor: string; distributionPoolMinor: string };
    matches: ReadonlyArray<{
        period: string;
        sourceSystem: "BANK" | "LEDGER";
        processorRef: string;
        comparedRef: string;
        deltaMinor: string;
        status: "EXACT" | "DIFFERENCE";
    }>;
    issues: ReadonlyArray<ReconciliationIssue>;
}>;

const requiredKeys = [
    "PROCESSOR:RECEIPT",
    "BANK:RECEIPT",
    "LEDGER:RECEIPT",
    "EXPENSE:OPERATING",
    "EXPENSE:TAX",
    "EXPENSE:RESERVE",
    "EXPENSE:EXCLUDED",
    "DEBT:DEBT_SERVICE",
] as const;

export function buildFinancialReview(
    inputRows: FinancialRow[],
    inputMetrics: CustomerMetric[],
    rateBasisPoints: number,
): FinancialReview {
    basisPoints(rateBasisPoints);
    const rows = z.array(financialRowSchema).parse(inputRows);
    const metrics = z.array(customerMetricSchema).parse(inputMetrics);
    const sourceRefs = [...rows.map((row) => row.sourceRef), ...metrics.map((metric) => metric.sourceRef)];
    if (new Set(sourceRefs).size !== sourceRefs.length) throw new Error("Duplicate source reference");
    const periods = [...new Set(rows.map((row) => row.period))].sort();
    if (periods.length !== 12 || metrics.length !== 12)
        throw new Error("Exactly 12 financial and metric periods are required");
    const matches: FinancialReview["matches"][number][] = [];
    const issues: ReconciliationIssue[] = [];
    let annualCash = 0n;
    let annualPool = 0n;

    const monthly = periods.map((period) => {
        const periodRows = rows.filter((row) => row.period === period);
        const byKey = new Map(periodRows.map((row) => [`${row.sourceSystem}:${row.category}`, row]));
        if (
            periodRows.length !== requiredKeys.length ||
            byKey.size !== requiredKeys.length ||
            requiredKeys.some((key) => !byKey.has(key))
        ) {
            throw new Error(`Missing or duplicate financial category in ${period}`);
        }
        const metric = metrics.find((item) => item.period === period);
        if (!metric || metrics.filter((item) => item.period === period).length !== 1) {
            throw new Error(`Missing or duplicate customer metric in ${period}`);
        }
        const get = (key: (typeof requiredKeys)[number]): FinancialRow => {
            const row = byKey.get(key);
            if (!row) throw new Error(`Missing ${key} in ${period}`);
            return row;
        };
        const processor = get("PROCESSOR:RECEIPT");
        for (const system of ["BANK", "LEDGER"] as const) {
            const compared = get(`${system}:RECEIPT`);
            const deltaMinor = (BigInt(compared.amountMinor) - BigInt(processor.amountMinor)).toString();
            const status = deltaMinor === "0" ? "EXACT" : "DIFFERENCE";
            matches.push({
                period,
                sourceSystem: system,
                processorRef: processor.sourceRef,
                comparedRef: compared.sourceRef,
                deltaMinor,
                status,
            });
            if (status === "DIFFERENCE")
                issues.push({
                    caseKey: `${system}_MISMATCH:${period}`,
                    kind: `${system}_MISMATCH`,
                    period,
                    sourceRefs: [processor.sourceRef, compared.sourceRef],
                    deltaMinor,
                    suggestion: system === "BANK" ? "REVIEW_TIMING" : "REVIEW_LEDGER",
                });
        }
        for (const row of periodRows.filter((item) => item.relatedParty))
            issues.push({
                caseKey: `RELATED_PARTY:${row.sourceRef}`,
                kind: "RELATED_PARTY",
                period,
                sourceRefs: [row.sourceRef],
                deltaMinor: "0",
                suggestion: "REVIEW_RELATED_PARTY",
            });
        const line = (row: FinancialRow): MoneyLine => ({
            amountMinor: row.amountMinor,
            sourceRefs: [row.sourceRef],
        });
        const lines = {
            receipts: line(processor),
            operating: line(get("EXPENSE:OPERATING")),
            tax: line(get("EXPENSE:TAX")),
            debt: line(get("DEBT:DEBT_SERVICE")),
            reserve: line(get("EXPENSE:RESERVE")),
            excluded: line(get("EXPENSE:EXCLUDED")),
        };
        const calculation = calculateCashPeriod(
            {
                period,
                evidenceReference: processor.evidenceRef,
                reconciliationStatus: "PREVIEW_UNRECONCILED",
                eligibleReceiptsMinor: lines.receipts.amountMinor,
                operatingExpensesMinor: lines.operating.amountMinor,
                taxesMinor: lines.tax.amountMinor,
                debtServiceMinor: lines.debt.amountMinor,
                reserveContributionMinor: lines.reserve.amountMinor,
                excludedItemsMinor: lines.excluded.amountMinor,
            },
            rateBasisPoints,
        );
        annualCash += calculation.definedDistributableCashMinor;
        annualPool += calculation.distributionPoolMinor;
        return {
            period,
            lines,
            definedDistributableCashMinor: calculation.definedDistributableCashMinor.toString(),
            distributionPoolMinor: calculation.distributionPoolMinor.toString(),
            customerMetricSourceRef: metric.sourceRef,
        };
    });
    return {
        formulaVersion: "sample-distributable-cash-v1",
        rounding: "floor-minor-unit-per-period",
        periods: monthly,
        annual: {
            definedDistributableCashMinor: annualCash.toString(),
            distributionPoolMinor: annualPool.toString(),
        },
        matches,
        issues,
    };
}
