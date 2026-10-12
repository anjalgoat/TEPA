import { describe, expect, it } from "vitest";

import { addMoney, multiplyBasisPointsFloor, parseMoney, serializeMoney } from "./money.js";

describe("exact money", () => {
    it("parses and serializes amounts beyond JavaScript's safe integer range", () => {
        const value = parseMoney({ amountMinor: "9007199254740993", currency: "USD", decimals: 2 });
        expect(value.amountMinor).toBe(9007199254740993n);
        expect(serializeMoney(value).amountMinor).toBe("9007199254740993");
    });

    it("rejects fractional and noncanonical strings, wrong decimals, and currency mixing", () => {
        expect(() => parseMoney({ amountMinor: "10.5", currency: "USD", decimals: 2 })).toThrow();
        expect(() => parseMoney({ amountMinor: "01", currency: "USD", decimals: 2 })).toThrow();
        expect(() => parseMoney({ amountMinor: "-0", currency: "USD", decimals: 2 })).toThrow();
        expect(() =>
            parseMoney({ amountMinor: "100", currency: "USD", decimals: 2, extra: "unexpected" }),
        ).toThrow();
        expect(() => parseMoney({ amountMinor: "100", currency: "TEST_USDC", decimals: 2 })).toThrow();
        expect(() =>
            addMoney(
                parseMoney({ amountMinor: "100", currency: "USD", decimals: 2 }),
                parseMoney({ amountMinor: "100", currency: "TEST_USDC", decimals: 6 }),
            ),
        ).toThrow("mismatch");
    });

    it("uses floor division at the documented basis-point boundary", () => {
        expect(multiplyBasisPointsFloor(19n, 1_000)).toBe(1n);
        expect(multiplyBasisPointsFloor(0n, 1_000)).toBe(0n);
        expect(() => multiplyBasisPointsFloor(-1n, 1_000)).toThrow();
        expect(() => multiplyBasisPointsFloor(1n, 10_001)).toThrow();
    });
});
