import pg from "pg";
import { isAddress } from "viem";
import { parseStartupConfig } from "../../config.js";
import { processOneIssuance, processOneRevocation, recheckRecordedIssuances } from "./worker.js";

const config = parseStartupConfig(process.env);
const rpcUrl = process.env.CHAIN_RPC_URL ?? config.BASE_SEPOLIA_RPC_URL;
const tokenAddress = process.env.TEPA_TOKEN_ADDRESS;
const privateKey = process.env.ISSUANCE_PRIVATE_KEY;
const codeHash = process.env.TEPA_TOKEN_CODE_HASH || undefined;
if (
    !rpcUrl ||
    !tokenAddress ||
    !isAddress(tokenAddress) ||
    !privateKey ||
    !/^0x[0-9a-fA-F]{64}$/.test(privateKey) ||
    (config.CHAIN_ID === 84532 && !codeHash) ||
    (codeHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(codeHash))
) {
    throw new Error(
        "A matching RPC, token address, signer key, and Base Sepolia bytecode hash are required for the issuance worker",
    );
}
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 });
try {
    let outcome: Awaited<ReturnType<typeof processOneIssuance>>;
    const settings = {
        rpcUrl,
        tokenAddress,
        privateKey: privateKey as `0x${string}`,
        ...(codeHash ? { codeHash: codeHash as `0x${string}` } : {}),
    };
    do {
        outcome = await processOneRevocation(pool, config, settings);
        if (outcome === "RECONCILIATION_REQUIRED") break;
    } while (outcome !== "IDLE");
    do {
        outcome = await processOneIssuance(pool, config, settings);
        if (outcome === "RECONCILIATION_REQUIRED") break;
    } while (outcome !== "IDLE");
    const mismatches = await recheckRecordedIssuances(pool, config, settings);
    console.log(`Issuance worker stopped: ${outcome}; recorded-balance mismatches: ${mismatches}`);
} finally {
    await pool.end();
}
