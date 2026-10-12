import { describe, expect, it } from "vitest";

import { offeringSchema } from "./offering.js";

describe("offeringSchema", () => {
    it("accepts the fictional MVP offering", () => {
        const result = offeringSchema.safeParse({
            schemaVersion: 1,
            fictional: true,
            issuerName: "Example SaaS, Inc.",
            network: "base-sepolia",
            unitCount: 1_000,
            initialUnitPrice: { amountMinor: "10000", currency: "USD", decimals: 2 },
            participationBasisPoints: 1_000,
            secondaryTradingEnabled: false,
        });

        expect(result.success).toBe(true);
    });

    it("rejects enabled secondary trading", () => {
        const result = offeringSchema.safeParse({
            schemaVersion: 1,
            fictional: true,
            issuerName: "Example SaaS, Inc.",
            network: "base-sepolia",
            unitCount: 1_000,
            initialUnitPrice: { amountMinor: "10000", currency: "USD", decimals: 2 },
            participationBasisPoints: 1_000,
            secondaryTradingEnabled: true,
        });

        expect(result.success).toBe(false);
    });

    it("rejects changed sample offering economics", () => {
        expect(
            offeringSchema.safeParse({
                schemaVersion: 1,
                fictional: true,
                issuerName: "Example SaaS, Inc.",
                network: "base-sepolia",
                unitCount: 1_000,
                initialUnitPrice: { amountMinor: "10100", currency: "USD", decimals: 2 },
                participationBasisPoints: 1_000,
                secondaryTradingEnabled: false,
            }).success,
        ).toBe(false);
    });
});
