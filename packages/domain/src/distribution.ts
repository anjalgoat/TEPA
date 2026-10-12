import { z } from "zod";

const wholeUnits = z.string().regex(/^(0|[1-9]\d*)$/);

export const distributionHolderSchema = z.strictObject({
    holderRef: z.string().min(1),
    walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    eligibleUnits: wholeUnits,
});

export type DistributionHolder = z.infer<typeof distributionHolderSchema>;

export type DistributionEntitlement = DistributionHolder & {
    amountMinor: string;
    remainder: string;
    roundingUnitAwarded: boolean;
};

export function allocateDistribution(poolMinor: bigint, input: readonly DistributionHolder[]) {
    if (poolMinor < 0n) throw new Error("Distribution pool must be nonnegative");
    const holders = z.array(distributionHolderSchema).parse(input);
    const refs = new Set<string>();
    const wallets = new Set<string>();
    for (const holder of holders) {
        const wallet = holder.walletAddress.toLowerCase();
        if (refs.has(holder.holderRef) || wallets.has(wallet))
            throw new Error("Distribution holders and wallets must be unique");
        refs.add(holder.holderRef);
        wallets.add(wallet);
    }
    const totalEligibleUnits = holders.reduce((sum, holder) => sum + BigInt(holder.eligibleUnits), 0n);
    if (totalEligibleUnits === 0n && poolMinor > 0n)
        throw new Error("Cannot allocate a positive distribution without eligible units");
    const rows = holders.map((holder) => {
        const numerator = poolMinor * BigInt(holder.eligibleUnits);
        return {
            ...holder,
            amount: totalEligibleUnits === 0n ? 0n : numerator / totalEligibleUnits,
            remainder: totalEligibleUnits === 0n ? 0n : numerator % totalEligibleUnits,
            roundingUnitAwarded: false,
        };
    });
    let residual = poolMinor - rows.reduce((sum, row) => sum + row.amount, 0n);
    const rank = [...rows].sort(
        (left, right) =>
            (left.remainder === right.remainder ? 0 : left.remainder > right.remainder ? -1 : 1) ||
            left.walletAddress.toLowerCase().localeCompare(right.walletAddress.toLowerCase()) ||
            left.holderRef.localeCompare(right.holderRef),
    );
    for (const row of rank) {
        if (residual === 0n) break;
        row.amount += 1n;
        row.roundingUnitAwarded = true;
        residual -= 1n;
    }
    if (residual !== 0n) throw new Error("Distribution rounding failed");
    return {
        formulaVersion: "distribution-largest-remainder-v1" as const,
        rounding: "floor-then-largest-remainder-wallet-ascending" as const,
        poolMinor: poolMinor.toString(),
        totalEligibleUnits: totalEligibleUnits.toString(),
        entitlements: rows
            .sort((left, right) => left.holderRef.localeCompare(right.holderRef))
            .map((row): DistributionEntitlement => ({
                holderRef: row.holderRef,
                walletAddress: row.walletAddress,
                eligibleUnits: row.eligibleUnits,
                amountMinor: row.amount.toString(),
                remainder: row.remainder.toString(),
                roundingUnitAwarded: row.roundingUnitAwarded,
            })),
    };
}

export function usdCentsToTestUsdcUnits(cents: bigint): bigint {
    if (cents < 0n) throw new Error("Amount must be nonnegative");
    return cents * 10_000n;
}
