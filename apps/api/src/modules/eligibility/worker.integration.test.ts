import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { parseStartupConfig } from "../../config.js";
import { migrate } from "../../migrate.js";
import { subjectHash } from "./service.js";
import { processOneIssuance, processOneRevocation, recheckRecordedIssuances } from "./worker.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const abi = parseAbi([
    "function grantRole(bytes32,address)",
    "function ISSUER_AGENT_ROLE() view returns (bytes32)",
    "function COMPLIANCE_ROLE() view returns (bytes32)",
    "function BUYBACK_ROLE() view returns (bytes32)",
    "function burnForSettlement(address,uint256,bytes32,bool)",
    "function balanceOf(address) view returns (uint256)",
    "function isVerified(address) view returns (bool)",
]);

async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return address.port;
}

const stubVault = `0x${"9".repeat(40)}` as const;
async function setVaultCode(client: ReturnType<typeof createPublicClient>, code: Hex) {
    await client.request({ method: "anvil_setCode", params: [stubVault, code] } as Parameters<
        typeof client.request
    >[0]);
}

describe.skipIf(!databaseUrl)("Phase 2 chain reconciliation", () => {
    let pool: pg.Pool;
    let anvil: ChildProcess;
    let rpcUrl: string;
    let tokenAddress: `0x${string}`;
    let privateKey: Hex;
    const holderRef = "synthetic-holder-a";
    const holderWallet = privateKeyToAccount(generatePrivateKey());
    beforeAll(async () => {
        await migrate(databaseUrl!);
        pool = new pg.Pool({ connectionString: databaseUrl });
        await pool.query(`TRUNCATE phase2_chain_steps,phase2_operations,wallet_challenges,phase2_holders,prototype_terms,
            financial_operations,financial_approvals,financial_review_cases,customer_metric_rows,
            financial_source_rows,financial_imports,issuers,audit_events,outbox_events CASCADE`);
        const port = await freePort();
        rpcUrl = `http://127.0.0.1:${port}`;
        anvil = spawn("anvil", ["--port", String(port), "--chain-id", "31337", "--silent"], {
            stdio: "ignore",
        });
        const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
        for (let attempt = 0; attempt < 40; attempt++) {
            try {
                if ((await client.getChainId()) === 31337) break;
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }
        expect(await client.getChainId()).toBe(31337);
        privateKey = generatePrivateKey();
        const account = privateKeyToAccount(privateKey);
        await client.request({
            method: "anvil_setBalance",
            params: [account.address, "0x3635C9ADC5DEA00000"],
        } as Parameters<typeof client.request>[0]);
        const wallet = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });
        const artifact = JSON.parse(
            readFileSync(
                new URL("../../../../../smart-contract/out/TepaToken.sol/TepaToken.json", import.meta.url),
                "utf8",
            ),
        ) as { abi: unknown[]; bytecode: { object: Hex } };
        const deployHash = await wallet.deployContract({
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            args: [account.address, 31337],
        });
        const receipt = await client.waitForTransactionReceipt({ hash: deployHash });
        if (!receipt.contractAddress) throw new Error("No deployment address");
        tokenAddress = receipt.contractAddress;
        for (const roleFunction of ["COMPLIANCE_ROLE", "ISSUER_AGENT_ROLE"] as const) {
            const role = await client.readContract({
                address: tokenAddress,
                abi,
                functionName: roleFunction,
            });
            const tx = await wallet.writeContract({
                address: tokenAddress,
                abi,
                functionName: "grantRole",
                args: [role, account.address],
            });
            expect((await client.waitForTransactionReceipt({ hash: tx })).status).toBe("success");
        }
        const issuer = await pool.query<{ id: string }>(
            "INSERT INTO issuers (public_id,display_name,fictional,version) VALUES ('example-saas','Example SaaS, Inc.',true,0) RETURNING id",
        );
        const operationId = randomUUID();
        await pool.query(
            `INSERT INTO phase2_holders (issuer_id,holder_ref,subject_hash,planned_units,eligibility_status,eligibility_decision_id,eligibility_expires_at,jurisdiction,wallet_address,subscription_status,allocation_case_id)
            VALUES ($1,$2,$3,600,'APPROVED',$4,now()+interval '1 day','US',$5,'ALLOCATED',$6)`,
            [
                issuer.rows[0]!.id,
                holderRef,
                subjectHash(holderRef),
                randomUUID(),
                holderWallet.address,
                randomUUID(),
            ],
        );
        await pool.query(
            `INSERT INTO phase2_operations (id,actor_ref,action,idempotency_key,request_sha256,resource_version,status,response)
            VALUES ($1,'synthetic:registry-agent',$2,$3,$4,1,'PENDING',$5::jsonb)`,
            [
                operationId,
                `ISSUE:${holderRef}`,
                randomUUID(),
                "a".repeat(64),
                JSON.stringify({ operationId, status: "PENDING", resourceVersion: 1 }),
            ],
        );
        await pool.query(
            "INSERT INTO outbox_events (operation_id,event_type,payload) VALUES ($1,'DEMO_ISSUANCE_REQUESTED','{}'::jsonb)",
            [operationId],
        );
    });
    afterAll(async () => {
        if (pool) await pool.end();
        if (anvil) anvil.kill("SIGTERM");
    });
    it("records the exact chain balance after three confirmed writes", async () => {
        const config = parseStartupConfig({ APP_ENV: "test", DATABASE_URL: databaseUrl });
        expect(await processOneIssuance(pool, config, { rpcUrl, tokenAddress, privateKey })).toBe(
            "CONFIRMED",
        );
        const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
        expect(
            await client.readContract({
                address: tokenAddress,
                abi,
                functionName: "balanceOf",
                args: [holderWallet.address],
            }),
        ).toBe(600n);
        const holder = await pool.query<{ recorded_units: number; subscription_status: string }>(
            "SELECT recorded_units,subscription_status FROM phase2_holders WHERE holder_ref=$1",
            [holderRef],
        );
        expect(holder.rows[0]?.recorded_units).toBe(600);
        expect(holder.rows[0]?.subscription_status).toBe("RECORDED");
        const steps = await pool.query("SELECT step FROM phase2_chain_steps ORDER BY step");
        expect(steps.rows.map((row) => row.step)).toEqual(["ALLOCATION", "ELIGIBILITY", "MINT"]);
        const audit = await pool.query<{ chain_command_id: string | null; chain_event_id: string | null }>(
            "SELECT chain_command_id,chain_event_id FROM audit_events WHERE action='DEMO_ISSUANCE_RECONCILED'",
        );
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0]?.chain_command_id).toBeTruthy();
        expect(audit.rows[0]?.chain_event_id).toBeTruthy();
        expect(await processOneIssuance(pool, config, { rpcUrl, tokenAddress, privateKey })).toBe("IDLE");
    });
    it("flags an unexpected burn despite an unrecorded allocation in a funded case", async () => {
        const config = parseStartupConfig({ APP_ENV: "test", DATABASE_URL: databaseUrl });
        const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
        const wallet = createWalletClient({
            account: privateKeyToAccount(privateKey),
            chain: foundry,
            transport: http(rpcUrl),
        });
        const role = await client.readContract({ address: tokenAddress, abi, functionName: "BUYBACK_ROLE" });
        const grant = await wallet.writeContract({
            address: tokenAddress,
            abi,
            functionName: "grantRole",
            args: [role, wallet.account.address],
        });
        await client.waitForTransactionReceipt({ hash: grant });
        const holder = (
            await pool.query<{ id: string; issuer_id: string }>(
                "SELECT id,issuer_id FROM phase2_holders WHERE holder_ref=$1",
                [holderRef],
            )
        ).rows[0]!;
        const terms = await pool.query<{ id: string }>(
            "INSERT INTO prototype_terms(issuer_id,version,terms,sha256,published_by) VALUES($1,1,'{}',$2,'synthetic:issuer') RETURNING id",
            [holder.issuer_id, "a".repeat(64)],
        );
        const settlementCase = await pool.query<{ id: string }>(
            `INSERT INTO phase4_cases(issuer_id,kind,state,terms_id,input,input_sha256,prepared_by,vault_address)
             VALUES($1,'ACQUISITION','CLAIMABLE',$2,'{}',$3,'synthetic:issuer',$4) RETURNING id`,
            [holder.issuer_id, terms.rows[0]!.id, "b".repeat(64), stubVault],
        );
        await pool.query(
            `INSERT INTO phase4_allocations(case_id,holder_id,leaf_index,wallet_address,snapshot_units,accepted_units,
             amount_usd_minor,amount_test_usdc_minor,remainder,proof,leaf_hash)
             VALUES($1,$2,0,$3,600,125,2500000,25000000000,0,'[]',$4)`,
            [settlementCase.rows[0]!.id, holder.id, holderWallet.address, `0x${"c".repeat(64)}`],
        );
        const burn = await wallet.writeContract({
            address: tokenAddress,
            abi,
            functionName: "burnForSettlement",
            args: [holderWallet.address, 125n, `0x${"d".repeat(64)}`, false],
        });
        await client.waitForTransactionReceipt({ hash: burn });
        // Vault stub: settled(...) returns false, so the burn is checked by the balance rule, not a failed read.
        await setVaultCode(client, "0x60206000f3");
        expect(await recheckRecordedIssuances(pool, config, { rpcUrl, tokenAddress })).toBe(1);
        const flagged = await pool.query(
            "SELECT subscription_status FROM phase2_holders WHERE holder_ref=$1",
            [holderRef],
        );
        expect(flagged.rows[0]?.subscription_status).toBe("RECONCILIATION_REQUIRED");
        const audit = await pool.query<{ chain_command_id: string | null; chain_event_id: string | null }>(
            "SELECT chain_command_id,chain_event_id FROM audit_events WHERE action='CHAIN_RECONCILIATION_REQUIRED' ORDER BY occurred_at DESC LIMIT 1",
        );
        expect(audit.rows[0]?.chain_command_id).toBeTruthy();
        expect(audit.rows[0]?.chain_event_id).toBeTruthy();
    });
    it("accepts a settled, unrecorded allocation only at the exact remaining balance", async () => {
        const config = parseStartupConfig({ APP_ENV: "test", DATABASE_URL: databaseUrl });
        const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
        // Vault stub: settled(...) returns true. The 125-unit burn above now has a matching unrecorded settlement.
        await setVaultCode(client, "0x600160005260206000f3");
        await pool.query("UPDATE phase2_holders SET subscription_status='RECORDED' WHERE holder_ref=$1", [
            holderRef,
        ]);
        expect(await recheckRecordedIssuances(pool, config, { rpcUrl, tokenAddress })).toBe(0);
        // A second settled allocation is recorded, but no matching units left the wallet: 75 are unexplained.
        const existing = (
            await pool.query<{ issuer_id: string; terms_id: string; holder_id: string }>(
                `SELECT c.issuer_id,c.terms_id,a.holder_id FROM phase4_allocations a
                 JOIN phase4_cases c ON c.id=a.case_id WHERE a.wallet_address=$1`,
                [holderWallet.address],
            )
        ).rows[0]!;
        // The recheck reads settled() for every unreceipted allocation with a vault, whatever the case state;
        // CANCELLED only keeps this second case clear of the one-active-acquisition index.
        const secondCase = await pool.query<{ id: string }>(
            `INSERT INTO phase4_cases(issuer_id,kind,state,terms_id,input,input_sha256,prepared_by,vault_address)
             VALUES($1,'ACQUISITION','CANCELLED',$2,'{}',$3,'synthetic:issuer',$4) RETURNING id`,
            [existing.issuer_id, existing.terms_id, "f".repeat(64), stubVault],
        );
        await pool.query(
            `INSERT INTO phase4_allocations(case_id,holder_id,leaf_index,wallet_address,snapshot_units,accepted_units,
             amount_usd_minor,amount_test_usdc_minor,remainder,proof,leaf_hash)
             VALUES($1,$2,0,$3,600,75,1500000,15000000000,0,'[]',$4)`,
            [secondCase.rows[0]!.id, existing.holder_id, holderWallet.address, `0x${"e".repeat(64)}`],
        );
        expect(await recheckRecordedIssuances(pool, config, { rpcUrl, tokenAddress })).toBe(1);
        const flagged = await pool.query(
            "SELECT subscription_status FROM phase2_holders WHERE holder_ref=$1",
            [holderRef],
        );
        expect(flagged.rows[0]?.subscription_status).toBe("RECONCILIATION_REQUIRED");
    });
    it("does not mint when the queued holder is revoked", async () => {
        const issuer = await pool.query<{ id: string }>(
            "SELECT id FROM issuers WHERE public_id='example-saas'",
        );
        const secondWallet = privateKeyToAccount(generatePrivateKey());
        const secondRef = "synthetic-holder-b";
        const operationId = randomUUID();
        await pool.query(
            `INSERT INTO phase2_holders (issuer_id,holder_ref,subject_hash,planned_units,eligibility_status,eligibility_decision_id,eligibility_expires_at,jurisdiction,wallet_address,subscription_status,allocation_case_id)
            VALUES ($1,$2,$3,400,'REVOKED',$4,now()+interval '1 day','US',$5,'ALLOCATED',$6)`,
            [
                issuer.rows[0]!.id,
                secondRef,
                subjectHash(secondRef),
                randomUUID(),
                secondWallet.address,
                randomUUID(),
            ],
        );
        await pool.query(
            `INSERT INTO phase2_operations (id,actor_ref,action,idempotency_key,request_sha256,resource_version,status,response)
            VALUES ($1,'synthetic:registry-agent',$2,$3,$4,2,'PENDING',$5::jsonb)`,
            [
                operationId,
                `ISSUE:${secondRef}`,
                randomUUID(),
                "c".repeat(64),
                JSON.stringify({ operationId, status: "PENDING", resourceVersion: 2 }),
            ],
        );
        await pool.query(
            "INSERT INTO outbox_events (operation_id,event_type,payload) VALUES ($1,'DEMO_ISSUANCE_REQUESTED','{}'::jsonb)",
            [operationId],
        );
        const config = parseStartupConfig({ APP_ENV: "test", DATABASE_URL: databaseUrl });
        expect(await processOneIssuance(pool, config, { rpcUrl, tokenAddress, privateKey })).toBe(
            "RECONCILIATION_REQUIRED",
        );
        const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
        expect(
            await client.readContract({
                address: tokenAddress,
                abi,
                functionName: "balanceOf",
                args: [secondWallet.address],
            }),
        ).toBe(0n);
    });
    it("revokes the on-chain wallet before confirming a revocation", async () => {
        const operationId = randomUUID();
        await pool.query("UPDATE phase2_holders SET eligibility_status='REVOKED' WHERE holder_ref=$1", [
            holderRef,
        ]);
        await pool.query(
            `INSERT INTO phase2_operations (id,actor_ref,action,idempotency_key,request_sha256,resource_version,status,response)
            VALUES ($1,'synthetic:compliance-operator',$2,$3,$4,2,'PENDING',$5::jsonb)`,
            [
                operationId,
                `REVOKE:${holderRef}`,
                randomUUID(),
                "b".repeat(64),
                JSON.stringify({ operationId, status: "PENDING", resourceVersion: 2 }),
            ],
        );
        await pool.query(
            "INSERT INTO outbox_events (operation_id,event_type,payload) VALUES ($1,'SIMULATED_ELIGIBILITY_REVOKED','{}'::jsonb)",
            [operationId],
        );
        const config = parseStartupConfig({ APP_ENV: "test", DATABASE_URL: databaseUrl });
        expect(await processOneRevocation(pool, config, { rpcUrl, tokenAddress, privateKey })).toBe(
            "CONFIRMED",
        );
        const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
        expect(
            await client.readContract({
                address: tokenAddress,
                abi,
                functionName: "isVerified",
                args: [holderWallet.address],
            }),
        ).toBe(false);
        const operation = await pool.query("SELECT status FROM phase2_operations WHERE id=$1", [operationId]);
        expect(operation.rows[0]?.status).toBe("CONFIRMED");
    });
    it("flags a missing mint receipt after a simulated chain reset", async () => {
        const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
        await pool.query("UPDATE phase2_holders SET subscription_status='RECORDED' WHERE holder_ref=$1", [
            holderRef,
        ]);
        await client.request({ method: "anvil_reset", params: [] } as Parameters<typeof client.request>[0]);
        const config = parseStartupConfig({ APP_ENV: "test", DATABASE_URL: databaseUrl });
        expect(await recheckRecordedIssuances(pool, config, { rpcUrl, tokenAddress })).toBe(1);
        const holder = await pool.query(
            "SELECT subscription_status FROM phase2_holders WHERE holder_ref=$1",
            [holderRef],
        );
        expect(holder.rows[0]?.subscription_status).toBe("RECONCILIATION_REQUIRED");
        expect(await processOneIssuance(pool, config, { rpcUrl, tokenAddress, privateKey })).toBe("IDLE");
    });
});
