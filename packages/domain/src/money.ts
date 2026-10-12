import { z } from "zod";

export const currencySchema = z.enum(["USD", "TEST_USDC"]);
export type Currency = z.infer<typeof currencySchema>;

const minorUnitsSchema = z.string().regex(/^(0|[1-9]\d*|-[1-9]\d*)$/);

export const moneyInputSchema = z
    .object({
        amountMinor: minorUnitsSchema,
        currency: currencySchema,
        decimals: z.literal(2).or(z.literal(6)),
    })
    .strict()
    .superRefine((value, context) => {
        if (
            (value.currency === "USD" && value.decimals !== 2) ||
            (value.currency === "TEST_USDC" && value.decimals !== 6)
        ) {
            context.addIssue({
                code: "custom",
                message: "Currency decimals do not match",
                path: ["decimals"],
            });
        }
    });

export type MoneyInput = z.infer<typeof moneyInputSchema>;
export type Money = Readonly<{ amountMinor: bigint; currency: Currency; decimals: 2 | 6 }>;

export function parseMoney(input: unknown): Money {
    const value = moneyInputSchema.parse(input);
    return { amountMinor: BigInt(value.amountMinor), currency: value.currency, decimals: value.decimals };
}

export function serializeMoney(value: Money): MoneyInput {
    return moneyInputSchema.parse({
        amountMinor: value.amountMinor.toString(),
        currency: value.currency,
        decimals: value.decimals,
    });
}

export function assertSameCurrency(left: Money, right: Money): void {
    if (left.currency !== right.currency || left.decimals !== right.decimals) {
        throw new Error("Money currency or decimals mismatch");
    }
}

export function addMoney(left: Money, right: Money): Money {
    assertSameCurrency(left, right);
    return { ...left, amountMinor: left.amountMinor + right.amountMinor };
}

export function subtractMoney(left: Money, right: Money): Money {
    assertSameCurrency(left, right);
    return { ...left, amountMinor: left.amountMinor - right.amountMinor };
}

export function basisPoints(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
        throw new Error("Basis points must be an integer from 0 to 10000");
    }
    return value;
}

export function multiplyBasisPointsFloor(amountMinor: bigint, rateBasisPoints: number): bigint {
    if (amountMinor < 0n) throw new Error("Amount must be nonnegative");
    return (amountMinor * BigInt(basisPoints(rateBasisPoints))) / 10_000n;
}
