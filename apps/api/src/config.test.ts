import { describe, expect, it } from "vitest";

import { parseStartupConfig } from "./config.js";

describe("startup configuration", () => {
    it("uses safe local defaults", () => {
        const value = parseStartupConfig({});
        expect(value.APP_ENV).toBe("local");
        expect(value.CHAIN_ID).toBe(31337);
        expect(value.REAL_MONEY_ENABLED).toBe("false");
        expect(parseStartupConfig({ TEPA_TOKEN_ADDRESS: "" }).TEPA_TOKEN_ADDRESS).toBeUndefined();
    });

    it("accepts a configured Base Sepolia demo", () => {
        expect(
            parseStartupConfig({
                APP_ENV: "demo",
                CHAIN_ID: "84532",
                BASE_SEPOLIA_RPC_URL: "https://example.invalid/rpc",
            }).CHAIN_ID,
        ).toBe(84532);
    });

    it.each([
        { APP_ENV: "production" },
        { APP_ENV: "demo", CHAIN_ID: "1", BASE_SEPOLIA_RPC_URL: "https://example.invalid/rpc" },
        { APP_ENV: "demo", CHAIN_ID: "84532" },
        { REAL_MONEY_ENABLED: "true" },
        { MOCK_IDENTITY_PROVIDER: "false" },
        { SECONDARY_TRANSFERS_ENABLED: "true" },
        { PORT: "0" },
        { DATABASE_URL: "not-a-database" },
        { TEPA_TOKEN_ADDRESS: "0x1234" },
        { DEMO_HOLDER_A_ADDRESS: "0x1234" },
        { DEMO_HOLDER_A_ADDRESS: "0x1111111111111111111111111111111111111111" },
        {
            APP_ENV: "demo",
            CHAIN_ID: "84532",
            BASE_SEPOLIA_RPC_URL: "https://example.invalid/rpc",
            TEPA_TOKEN_ADDRESS: "0x1111111111111111111111111111111111111111",
        },
    ])("rejects invalid or live configuration %#", (environment) => {
        expect(() => parseStartupConfig(environment)).toThrow();
    });
});
