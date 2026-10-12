import { describe, expect, it } from "vitest";
import { allocateDistribution, usdCentsToTestUsdcUnits } from "./distribution.js";

const holders = [
    { holderRef: "b", walletAddress: "0x0000000000000000000000000000000000000002", eligibleUnits: "1" },
    { holderRef: "a", walletAddress: "0x0000000000000000000000000000000000000001", eligibleUnits: "1" },
    { holderRef: "c", walletAddress: "0x0000000000000000000000000000000000000003", eligibleUnits: "1" },
];

describe("distribution allocation", () => {
    it("conserves every minor unit and breaks equal remainders by wallet", () => {
        const result = allocateDistribution(5n, holders);
        expect(result.entitlements.map((row) => [row.holderRef, row.amountMinor])).toEqual([
            ["a", "2"],
            ["b", "2"],
            ["c", "1"],
        ]);
        expect(result.entitlements.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n)).toBe(5n);
    });

    it("handles zero pool and rejects zero denominator for a positive pool", () => {
        expect(allocateDistribution(0n, []).entitlements).toEqual([]);
        expect(() => allocateDistribution(1n, [])).toThrow("eligible units");
        expect(() => allocateDistribution(-1n, holders)).toThrow("nonnegative");
    });

    it("rejects duplicate wallets and uses exact test USDC scaling", () => {
        expect(() => allocateDistribution(1n, [holders[0]!, holders[0]!])).toThrow("unique");
        expect(usdCentsToTestUsdcUnits(123n)).toBe(1_230_000n);
    });

    it("conserves a large pool without floating-point arithmetic", () => {
        const pool = 10n ** 30n + 1n;
        const result = allocateDistribution(pool, holders);
        expect(result.entitlements.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n)).toBe(pool);
    });
});
