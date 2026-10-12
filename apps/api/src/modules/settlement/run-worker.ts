import pg from "pg";
import { parseStartupConfig } from "../../config.js";
import { processOneSettlement } from "./worker.js";

const config = parseStartupConfig(process.env);
const privateKey = process.env.SETTLEMENT_PRIVATE_KEY;
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey) || !config.TEST_USDC_ADDRESS)
    throw new Error("SETTLEMENT_PRIVATE_KEY and TEST_USDC_ADDRESS are required");
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 });
try {
    let result: Awaited<ReturnType<typeof processOneSettlement>>;
    do {
        result = await processOneSettlement(pool, config, {
            privateKey: privateKey as `0x${string}`,
            assetAddress: config.TEST_USDC_ADDRESS as `0x${string}`,
            ...(config.TEST_USDC_CODE_HASH
                ? { assetCodeHash: config.TEST_USDC_CODE_HASH as `0x${string}` }
                : {}),
        });
        console.log(result);
    } while (result === "CONFIRMED");
} finally {
    await pool.end();
}
