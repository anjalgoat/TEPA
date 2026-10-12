import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { isAddress } from "viem";

import { parseStartupConfig } from "./config.js";
import {
    processOneIssuance,
    processOneRevocation,
    recheckRecordedIssuances,
} from "./modules/eligibility/worker.js";
import { processOneDistribution, recheckDistributionEvidence } from "./modules/distributions/worker.js";
import { processOneSettlement } from "./modules/settlement/worker.js";

const config = parseStartupConfig(process.env);
const rpcUrl = config.CHAIN_RPC_URL ?? config.BASE_SEPOLIA_RPC_URL;
const tokenAddress = config.TEPA_TOKEN_ADDRESS;
const assetAddress = config.TEST_USDC_ADDRESS;
const issuanceKey = process.env.ISSUANCE_PRIVATE_KEY;
const distributionKey = process.env.DISTRIBUTION_PRIVATE_KEY;
const settlementKey = process.env.SETTLEMENT_PRIVATE_KEY;
const key = (value: string | undefined): value is `0x${string}` =>
    !!value && /^0x[0-9a-fA-F]{64}$/.test(value);

if (
    !rpcUrl ||
    !tokenAddress ||
    !isAddress(tokenAddress) ||
    !assetAddress ||
    !isAddress(assetAddress) ||
    !key(issuanceKey) ||
    !key(distributionKey) ||
    !key(settlementKey) ||
    (config.APP_ENV === "demo" && (!config.TEPA_TOKEN_CODE_HASH || !config.TEST_USDC_CODE_HASH))
) {
    throw new Error(
        "Demo worker needs configured demo contracts, RPC, three signer keys, and hosted bytecode hashes.",
    );
}

const issuanceSettings = {
    rpcUrl,
    tokenAddress,
    privateKey: issuanceKey,
    ...(config.TEPA_TOKEN_CODE_HASH ? { codeHash: config.TEPA_TOKEN_CODE_HASH as `0x${string}` } : {}),
};
const distributionSettings = {
    privateKey: distributionKey,
    assetAddress,
    ...(config.TEST_USDC_CODE_HASH ? { assetCodeHash: config.TEST_USDC_CODE_HASH as `0x${string}` } : {}),
};
const settlementSettings = {
    privateKey: settlementKey,
    assetAddress,
    ...(config.TEST_USDC_CODE_HASH ? { assetCodeHash: config.TEST_USDC_CODE_HASH as `0x${string}` } : {}),
};

const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 3 });
let running = true;
process.on("SIGINT", () => {
    running = false;
});
process.on("SIGTERM", () => {
    running = false;
});

async function drain(name: string, work: () => Promise<string>) {
    for (let count = 0; running && count < 20; count += 1) {
        const outcome = await work();
        if (outcome === "IDLE") return;
        console.log(`${name}: ${outcome}`);
        if (outcome !== "CONFIRMED") return;
    }
}

try {
    let lastRecheck = 0;
    while (running) {
        if (Date.now() - lastRecheck >= 30_000) {
            const issuanceMismatches = await recheckRecordedIssuances(pool, config, issuanceSettings);
            const distributionIncidents = await recheckDistributionEvidence(pool, config);
            if (issuanceMismatches || distributionIncidents)
                console.log(
                    `Reconciliation: ${issuanceMismatches} issuance, ${distributionIncidents} distribution.`,
                );
            lastRecheck = Date.now();
        }
        await drain("revocation", () => processOneRevocation(pool, config, issuanceSettings));
        await drain("issuance", () => processOneIssuance(pool, config, issuanceSettings));
        await drain("distribution", () => processOneDistribution(pool, config, distributionSettings));
        await drain("settlement", () => processOneSettlement(pool, config, settlementSettings));
        if (running) await delay(2_000);
    }
} catch {
    console.error("Demo worker stopped after an error. Inspect application reconciliation records.");
    process.exitCode = 1;
} finally {
    await pool.end();
}
