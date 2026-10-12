import { describe, expect, it } from "vitest";
import { assertLocalResetTarget } from "./demo-reset.js";

const local = {
    APP_ENV: "local",
    CHAIN_ID: "31337",
    DATABASE_URL: "postgresql://localhost:5432/tepa_test",
    CHAIN_RPC_URL: "http://127.0.0.1:8545",
};

describe("local demo reset guard", () => {
    it("accepts only an exact local database confirmation", () => {
        expect(assertLocalResetTarget(local, "tepa_test").databaseName).toBe("tepa_test");
        expect(() => assertLocalResetTarget(local, "tepa")).toThrow("Reset requires");
    });

    it("rejects remote stores, hosted mode, and configured contract addresses", () => {
        expect(() =>
            assertLocalResetTarget(
                { ...local, DATABASE_URL: "postgresql://db.example/tepa_test" },
                "tepa_test",
            ),
        ).toThrow("Reset requires");
        expect(() =>
            assertLocalResetTarget({ ...local, CHAIN_RPC_URL: "https://rpc.example" }, "tepa_test"),
        ).toThrow("Reset requires");
        expect(() =>
            assertLocalResetTarget(
                { ...local, APP_ENV: "demo", CHAIN_ID: "84532", BASE_SEPOLIA_RPC_URL: "https://rpc.example" },
                "tepa_test",
            ),
        ).toThrow("Reset requires");
        expect(() =>
            assertLocalResetTarget(
                { ...local, TEPA_TOKEN_ADDRESS: "0x1111111111111111111111111111111111111111" },
                "tepa_test",
            ),
        ).toThrow("Reset requires");
    });
});
