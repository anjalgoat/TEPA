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
import { createApp } from "../../app.js";
import { migrate } from "../../migrate.js";
import { loadFinancialFixture } from "../metrics/data.js";
import { caseHash, decisionHash, subjectHash } from "../eligibility/service.js";
import {
    advanceDistribution,
    cancelDistribution,
    getDistributions,
    prepareDistribution,
    recordClaim,
    requestChainStep,
    snapshotDistribution,
} from "./service.js";
import { processOneDistribution, recheckDistributionEvidence } from "./worker.js";
import { claimInLocalBrowser } from "./browser-claim.test-helper.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const tokenAbi = parseAbi([
    "function grantRole(bytes32,address)",
    "function COMPLIANCE_ROLE() view returns (bytes32)",
    "function ISSUER_AGENT_ROLE() view returns (bytes32)",
    "function RECOVERY_ROLE() view returns (bytes32)",
    "function setEligibility(address,bytes32,bytes32,uint64,bool)",
    "function recordAllocation(bytes32,address,uint16,bytes32)",
    "function mint(bytes32,address,uint16,bytes32)",
    "function recoveryAddress(address,address,bytes32) returns (bool)",
]);
const assetAbi = parseAbi([
    "function mint(address,uint256)",
    "function balanceOf(address) view returns (uint256)",
]);
const vaultAbi = parseAbi([
    "function claim(uint256,uint256,bytes32[])",
    "function entitlementRoot() view returns (bytes32)",
]);
async function freePort() {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return address.port;
}
const actor = (
    role: "ISSUER_PREPARER" | "FINANCE_REVIEWER" | "DISTRIBUTION_OPERATOR" | "INVESTOR_A" | "INVESTOR_B",
) => ({
    role,
    actorRef: `synthetic:${role.toLowerCase()}`,
});
const mutation = (role: Parameters<typeof actor>[0], action: string, expectedVersion: number) => ({
    actor: actor(role),
    action,
    key: randomUUID(),
    expectedVersion,
    reason: "Synthetic quarterly workflow test",
    body: {},
});

describe.skipIf(!databaseUrl)("Phase 3 distribution", () => {
    let pool: pg.Pool;
    let anvil: ChildProcess;
    let rpcUrl: string;
    let signerKey: Hex;
    let tokenAddress: `0x${string}`;
    let assetAddress: `0x${string}`;
    let issuerId: string;
    const holderKeys = [generatePrivateKey(), generatePrivateKey()];
    const holders = holderKeys.map((key) => privateKeyToAccount(key));
    const config = () =>
        parseStartupConfig({
            APP_ENV: "test",
            DATABASE_URL: databaseUrl,
            CHAIN_RPC_URL: rpcUrl,
            TEPA_TOKEN_ADDRESS: tokenAddress,
            TEST_USDC_ADDRESS: assetAddress,
        });

    beforeAll(async () => {
        await migrate(databaseUrl!);
        pool = new pg.Pool({ connectionString: databaseUrl });
        await pool.query(`TRUNCATE distribution_chain_steps,distribution_operations,distribution_claims,distribution_entitlements,
            distribution_epochs,phase2_chain_steps,phase2_operations,wallet_challenges,phase2_holders,prototype_terms,
            financial_operations,financial_approvals,financial_review_cases,customer_metric_rows,financial_source_rows,
            financial_imports,issuers,audit_events,outbox_events CASCADE`);
        rpcUrl = `http://127.0.0.1:${await freePort()}`;
        anvil = spawn("anvil", ["--port", new URL(rpcUrl).port, "--chain-id", "31337", "--silent"], {
            stdio: "ignore",
        });
        const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
        for (let i = 0; i < 50; i++) {
            try {
                if ((await publicClient.getChainId()) === 31337) break;
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }
        signerKey = generatePrivateKey();
        const signer = privateKeyToAccount(signerKey);
        for (const account of [signer, ...holders])
            await publicClient.request({
                method: "anvil_setBalance",
                params: [account.address, "0x3635C9ADC5DEA00000"],
            } as Parameters<typeof publicClient.request>[0]);
        const wallet = createWalletClient({ account: signer, chain: foundry, transport: http(rpcUrl) });
        async function deploy(name: string, args: unknown[]) {
            const artifact = JSON.parse(
                readFileSync(
                    new URL(`../../../../../smart-contract/out/${name}.sol/${name}.json`, import.meta.url),
                    "utf8",
                ),
            ) as { abi: unknown[]; bytecode: { object: Hex } };
            const tx = await wallet.deployContract({
                abi: artifact.abi,
                bytecode: artifact.bytecode.object,
                args,
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
            if (!receipt.contractAddress) throw new Error("No contract address");
            return receipt.contractAddress;
        }
        tokenAddress = await deploy("TepaToken", [signer.address, 31337]);
        assetAddress = await deploy("TestUsdc", []);
        for (const role of ["COMPLIANCE_ROLE", "ISSUER_AGENT_ROLE", "RECOVERY_ROLE"] as const) {
            const value = await publicClient.readContract({
                address: tokenAddress,
                abi: tokenAbi,
                functionName: role,
            });
            const tx = await wallet.writeContract({
                address: tokenAddress,
                abi: tokenAbi,
                functionName: "grantRole",
                args: [value, signer.address],
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });
        }
        for (const [index, holder] of holders.entries()) {
            const ref = index === 0 ? "synthetic-holder-a" : "synthetic-holder-b";
            const subject = subjectHash(ref);
            const decision = decisionHash(randomUUID());
            const caseId = caseHash(randomUUID());
            for (const [functionName, args] of [
                [
                    "setEligibility",
                    [holder.address, subject, decision, BigInt(Math.floor(Date.now() / 1000) + 86400), true],
                ],
                ["recordAllocation", [subject, holder.address, index === 0 ? 600 : 400, caseId]],
                ["mint", [subject, holder.address, index === 0 ? 600 : 400, caseId]],
            ] as const) {
                const tx = await wallet.writeContract({
                    address: tokenAddress,
                    abi: tokenAbi,
                    functionName,
                    args,
                });
                await publicClient.waitForTransactionReceipt({ hash: tx });
            }
        }
        const mint = await wallet.writeContract({
            address: assetAddress,
            abi: assetAbi,
            functionName: "mint",
            args: [signer.address, 100_000_000_000n],
        });
        await publicClient.waitForTransactionReceipt({ hash: mint });
        const issuer = await pool.query<{ id: string }>(
            "INSERT INTO issuers(public_id,display_name,version) VALUES('example-saas','Example SaaS, Inc.',0) RETURNING id",
        );
        issuerId = issuer.rows[0]!.id;
        const terms = await pool.query<{ id: string }>(
            "INSERT INTO prototype_terms(issuer_id,version,terms,sha256,published_by) VALUES($1,1,'{}',$2,'synthetic:issuer') RETURNING id",
            [issuerId, "a".repeat(64)],
        );
        const { fixture, inputSha256 } = loadFinancialFixture(1);
        const imported = await pool.query<{ id: string }>(
            "INSERT INTO financial_imports(issuer_id,fixture_version,input_sha256,imported_by) VALUES($1,1,$2,'synthetic:issuer') RETURNING id",
            [issuerId, inputSha256],
        );
        const importId = imported.rows[0]!.id;
        await pool.query("UPDATE issuers SET active_import_id=$2 WHERE id=$1", [issuerId, importId]);
        for (const row of fixture.rows)
            await pool.query(
                `INSERT INTO financial_source_rows(import_id,source_ref,source_system,period,category,amount_minor,evidence_ref,related_party,row_sha256)
            VALUES($1,$2,$3,$4,$5,$6::numeric,$7,$8,$9)`,
                [
                    importId,
                    row.sourceRef,
                    row.sourceSystem,
                    row.period,
                    row.category,
                    row.amountMinor,
                    row.evidenceRef,
                    row.relatedParty,
                    "b".repeat(64),
                ],
            );
        for (const row of fixture.metrics)
            await pool.query(
                `INSERT INTO customer_metric_rows(import_id,source_ref,period,active_customers,arr_minor,churn_basis_points,evidence_ref,row_sha256)
            VALUES($1,$2,$3,$4,$5::numeric,$6,$7,$8)`,
                [
                    importId,
                    row.sourceRef,
                    row.period,
                    row.activeCustomers,
                    row.arrMinor,
                    row.churnBasisPoints,
                    row.evidenceRef,
                    "c".repeat(64),
                ],
            );
        await pool.query(
            "INSERT INTO financial_approvals(import_id,input_sha256,decisions_sha256,formula_version,approved_by,reason) VALUES($1,$2,$3,'sample-distributable-cash-v1','synthetic:finance','Reviewed synthetic inputs')",
            [importId, inputSha256, "d".repeat(64)],
        );
        for (const [index, holder] of holders.entries()) {
            const ref = index === 0 ? "synthetic-holder-a" : "synthetic-holder-b";
            await pool.query(
                `INSERT INTO phase2_holders(issuer_id,holder_ref,subject_hash,planned_units,terms_id,eligibility_status,eligibility_decision_id,eligibility_expires_at,jurisdiction,wallet_address,subscription_status,recorded_units)
                VALUES($1,$2,$3,$4,$5,'APPROVED',$6,now()+interval '1 day','US',$7,'RECORDED',$4)`,
                [
                    issuerId,
                    ref,
                    subjectHash(ref),
                    index === 0 ? 600 : 400,
                    terms.rows[0]!.id,
                    randomUUID(),
                    holder.address,
                ],
            );
        }
    }, 30000);
    afterAll(async () => {
        if (pool) await pool.end();
        if (anvil) anvil.kill("SIGTERM");
    });

    it("funds a frozen snapshot and records both one-time claims", async () => {
        const prepared = await prepareDistribution(
            pool,
            { ...mutation("ISSUER_PREPARER", "PREPARE:2025-Q1", 0), body: { quarter: "2025-Q1" } },
            "2025-Q1",
        );
        const id = (prepared as Record<string, unknown>).epochId as string;
        await advanceDistribution(pool, mutation("ISSUER_PREPARER", `RECONCILED:${id}`, 1), id, "RECONCILED");
        await advanceDistribution(pool, mutation("FINANCE_REVIEWER", `REVIEWED:${id}`, 2), id, "REVIEWED");
        await advanceDistribution(pool, mutation("FINANCE_REVIEWER", `APPROVED:${id}`, 3), id, "APPROVED");
        const snap = await snapshotDistribution(
            pool,
            config(),
            mutation("DISTRIBUTION_OPERATOR", `SNAPSHOT:${id}`, 4),
            id,
        );
        const before = await getDistributions(pool, actor("FINANCE_REVIEWER"), 31337);
        expect(before.epochs[0]?.state).toBe("SNAPSHOTTED");
        expect(
            before.epochs[0]?.entitlements.reduce((sum, row) => sum + BigInt(row.amountUsdMinor), 0n),
        ).toBe(BigInt(before.epochs[0]!.poolUsdMinor));
        expect((snap as Record<string, unknown>).entitlementRoot).toBe(before.epochs[0]?.entitlementRoot);
        await requestChainStep(pool, mutation("DISTRIBUTION_OPERATOR", `FUND:${id}`, 5), id, "FUND");
        expect(await processOneDistribution(pool, config(), { privateKey: signerKey, assetAddress })).toBe(
            "CONFIRMED",
        );
        const funded = await getDistributions(pool, actor("FINANCE_REVIEWER"), 31337);
        expect(funded.epochs[0]?.state).toBe("FUNDED");
        expect(funded.epochs[0]?.chainSteps.some((item) => item.step === "FUND" && item.blockHash)).toBe(
            true,
        );
        await requestChainStep(pool, mutation("DISTRIBUTION_OPERATOR", `OPEN:${id}`, 6), id, "OPEN");
        expect(await processOneDistribution(pool, config(), { privateKey: signerKey, assetAddress })).toBe(
            "CONFIRMED",
        );
        const chainAudit = await pool.query<{
            action: string;
            chain_command_id: string;
            chain_event_id: string;
        }>(
            `SELECT action,chain_command_id,chain_event_id FROM audit_events
             WHERE resource_id=$1 AND action IN ('DISTRIBUTION_FUNDED','DISTRIBUTION_CLAIMS_OPENED')`,
            [id],
        );
        expect(chainAudit.rows).toHaveLength(2);
        expect(chainAudit.rows.every((row) => row.chain_command_id && row.chain_event_id)).toBe(true);
        const claimable = await getDistributions(pool, actor("INVESTOR_A"), 31337);
        const epoch = claimable.epochs[0]!;
        expect(epoch.state).toBe("CLAIMABLE");
        expect(epoch.importId).toBe(before.epochs[0]?.importId);
        expect(epoch.termsId).toBe(before.epochs[0]?.termsId);
        expect(epoch.eligibleSupply).toBe("1000");
        expect(epoch.entitlements).toHaveLength(1);
        const entitlement = epoch.entitlements[0]!;
        if (process.env.BROWSER_BIN) {
            await claimInLocalBrowser({
                pool,
                databaseUrl: databaseUrl!,
                rpcUrl,
                tokenAddress,
                assetAddress,
                holderKeys,
                browserBin: process.env.BROWSER_BIN,
                distributionEpochId: id,
            });
            const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
            const claims = await pool.query<{ tx_hash: Hex }>(
                `SELECT c.tx_hash FROM distribution_claims c JOIN distribution_entitlements e
                 ON e.id=c.entitlement_id JOIN phase2_holders h ON h.id=e.holder_id
                 WHERE e.epoch_id=$1 ORDER BY h.holder_ref`,
                [id],
            );
            expect(claims.rows).toHaveLength(2);
            for (const [index, amount] of [612_000_000n, 408_000_000n].entries()) {
                expect(
                    await publicClient.readContract({
                        address: assetAddress,
                        abi: assetAbi,
                        functionName: "balanceOf",
                        args: [holders[index]!.address],
                    }),
                ).toBe(amount);
            }
            const duplicateWallet = createWalletClient({
                account: holders[0]!,
                chain: foundry,
                transport: http(rpcUrl),
            });
            await expect(
                duplicateWallet.writeContract({
                    address: epoch.vaultAddress!,
                    abi: vaultAbi,
                    functionName: "claim",
                    args: [
                        BigInt(entitlement.index),
                        BigInt(entitlement.amountTestUsdcMinor),
                        entitlement.proof,
                    ],
                }),
            ).rejects.toThrow();
            await expect(
                recordClaim(
                    pool,
                    config(),
                    {
                        ...mutation("INVESTOR_A", `CLAIM:${id}:duplicate`, 9),
                        body: { txHash: claims.rows[0]!.tx_hash },
                    },
                    id,
                    claims.rows[0]!.tx_hash,
                ),
            ).rejects.toMatchObject({ code: "ALREADY_CLAIMED" });
            expect(await recheckDistributionEvidence(pool, config())).toBe(0);
            const claimAudit = await pool.query(
                `SELECT chain_command_id,chain_event_id FROM audit_events
                 WHERE resource_id=$1 AND action='DISTRIBUTION_CLAIM_RECORDED'`,
                [id],
            );
            expect(claimAudit.rows).toHaveLength(2);
            expect(claimAudit.rows.every((row) => row.chain_command_id && row.chain_event_id)).toBe(true);
            return;
        }
        const holderWallet = createWalletClient({
            account: holders[0]!,
            chain: foundry,
            transport: http(rpcUrl),
        });
        const tx = await holderWallet.writeContract({
            address: epoch.vaultAddress!,
            abi: vaultAbi,
            functionName: "claim",
            args: [BigInt(entitlement.index), BigInt(entitlement.amountTestUsdcMinor), entitlement.proof],
        });
        const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
        expect((await publicClient.waitForTransactionReceipt({ hash: tx })).status).toBe("success");
        await recordClaim(
            pool,
            config(),
            { ...mutation("INVESTOR_A", `CLAIM:${id}`, 7), body: { txHash: tx } },
            id,
            tx,
        );
        const recorded = await getDistributions(pool, actor("INVESTOR_A"), 31337);
        expect(recorded.epochs[0]?.entitlements[0]?.claimTxHash).toBe(tx);
        expect(
            await publicClient.readContract({
                address: assetAddress,
                abi: assetAbi,
                functionName: "balanceOf",
                args: [holders[0]!.address],
            }),
        ).toBe(BigInt(entitlement.amountTestUsdcMinor));
        const second = await getDistributions(pool, actor("INVESTOR_B"), 31337);
        const secondEntitlement = second.epochs[0]!.entitlements[0]!;
        const secondWallet = createWalletClient({
            account: holders[1]!,
            chain: foundry,
            transport: http(rpcUrl),
        });
        const secondTx = await secondWallet.writeContract({
            address: epoch.vaultAddress!,
            abi: vaultAbi,
            functionName: "claim",
            args: [
                BigInt(secondEntitlement.index),
                BigInt(secondEntitlement.amountTestUsdcMinor),
                secondEntitlement.proof,
            ],
        });
        expect((await publicClient.waitForTransactionReceipt({ hash: secondTx })).status).toBe("success");
        await recordClaim(
            pool,
            config(),
            {
                ...mutation("INVESTOR_B", `CLAIM:${id}`, 8),
                body: { txHash: secondTx },
            },
            id,
            secondTx,
        );
        expect(
            await publicClient.readContract({
                address: assetAddress,
                abi: assetAbi,
                functionName: "balanceOf",
                args: [holders[1]!.address],
            }),
        ).toBe(BigInt(secondEntitlement.amountTestUsdcMinor));
        await expect(
            secondWallet.writeContract({
                address: epoch.vaultAddress!,
                abi: vaultAbi,
                functionName: "claim",
                args: [
                    BigInt(secondEntitlement.index),
                    BigInt(secondEntitlement.amountTestUsdcMinor),
                    secondEntitlement.proof,
                ],
            }),
        ).rejects.toThrow();
        await expect(
            recordClaim(
                pool,
                config(),
                { ...mutation("INVESTOR_A", `CLAIM:${id}`, 9), body: { txHash: tx } },
                id,
                tx,
            ),
        ).rejects.toMatchObject({ code: "ALREADY_CLAIMED" });
        expect(await recheckDistributionEvidence(pool, config())).toBe(0);
        const claimAudit = await pool.query(
            `SELECT chain_command_id,chain_event_id FROM audit_events
             WHERE resource_id=$1 AND action='DISTRIBUTION_CLAIM_RECORDED'`,
            [id],
        );
        expect(claimAudit.rows).toHaveLength(2);
        expect(claimAudit.rows.every((row) => row.chain_command_id && row.chain_event_id)).toBe(true);
    }, 60000);

    it("rejects an auditor mutation and an invalid epoch transition", async () => {
        const current = await pool.query<{ version: number }>("SELECT version FROM issuers WHERE id=$1", [
            issuerId,
        ]);
        const version = current.rows[0]!.version;
        const app = createApp(config(), pool);
        const server = app.listen(0, "127.0.0.1");
        try {
            await new Promise<void>((resolve) => server.once("listening", resolve));
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("No API port");
            const base = `http://127.0.0.1:${address.port}`;
            const session = await fetch(`${base}/demo/session`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ role: "AUDITOR" }),
            });
            const { token } = (await session.json()) as { token: string };
            const response = await fetch(`${base}/api/v1/distributions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                    "If-Match": String(version),
                    "Idempotency-Key": randomUUID(),
                    "X-Action-Reason": "Auditor must not mutate epochs",
                },
                body: JSON.stringify({ quarter: "2025-Q2" }),
            });
            expect(response.status).toBe(403);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        const prepared = await prepareDistribution(
            pool,
            { ...mutation("ISSUER_PREPARER", "PREPARE:2025-Q2", version), body: { quarter: "2025-Q2" } },
            "2025-Q2",
        );
        const id = (prepared as Record<string, unknown>).epochId as string;
        await expect(
            advanceDistribution(
                pool,
                mutation("FINANCE_REVIEWER", `APPROVED:${id}`, version + 1),
                id,
                "APPROVED",
            ),
        ).rejects.toMatchObject({ code: "INVALID_EPOCH_STATE" });
        await cancelDistribution(pool, mutation("ISSUER_PREPARER", `CANCEL:${id}`, version + 1), id);
        const replacement = await prepareDistribution(
            pool,
            {
                ...mutation("ISSUER_PREPARER", "PREPARE:2025-Q2:revision2", version + 2),
                body: { quarter: "2025-Q2" },
            },
            "2025-Q2",
        );
        expect((replacement as Record<string, unknown>).revision).toBe(2);
        const list = await getDistributions(pool, actor("FINANCE_REVIEWER"), 31337);
        expect(list.epochs.filter((item) => item.quarter === "2025-Q2").map((item) => item.state)).toEqual([
            "DRAFT",
            "CANCELLED",
        ]);
    });

    it("keeps the record-date entitlement fixed after a wallet recovery", async () => {
        const before = await getDistributions(pool, actor("INVESTOR_A"), 31337);
        const epoch = before.epochs.find((item) => item.quarter === "2025-Q1")!;
        const replacement = privateKeyToAccount(generatePrivateKey());
        const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
        const signer = privateKeyToAccount(signerKey);
        const wallet = createWalletClient({ account: signer, chain: foundry, transport: http(rpcUrl) });
        const eligibility = await wallet.writeContract({
            address: tokenAddress,
            abi: tokenAbi,
            functionName: "setEligibility",
            args: [
                replacement.address,
                subjectHash("synthetic-holder-a"),
                decisionHash(randomUUID()),
                BigInt(Math.floor(Date.now() / 1000) + 86400),
                true,
            ],
        });
        await publicClient.waitForTransactionReceipt({ hash: eligibility });
        const recovery = await wallet.writeContract({
            address: tokenAddress,
            abi: tokenAbi,
            functionName: "recoveryAddress",
            args: [holders[0]!.address, replacement.address, caseHash(randomUUID())],
        });
        await publicClient.waitForTransactionReceipt({ hash: recovery });
        const after = await getDistributions(pool, actor("INVESTOR_A"), 31337);
        const fixed = after.epochs.find((item) => item.quarter === "2025-Q1")!;
        expect(fixed.entitlementRoot).toBe(epoch.entitlementRoot);
        expect(fixed.entitlements[0]?.walletAddress).toBe(epoch.entitlements[0]?.walletAddress);
        expect(fixed.entitlements[0]?.amountTestUsdcMinor).toBe(epoch.entitlements[0]?.amountTestUsdcMinor);
    });

    it("flags a confirmed claim and funding after a chain reset", async () => {
        const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
        await publicClient.request({ method: "anvil_reset", params: [] } as Parameters<
            typeof publicClient.request
        >[0]);
        expect(await recheckDistributionEvidence(pool, config())).toBe(1);
        const state = await getDistributions(pool, actor("FINANCE_REVIEWER"), 31337);
        expect(state.epochs.find((epoch) => epoch.quarter === "2025-Q1")?.state).toBe(
            "RECONCILIATION_REQUIRED",
        );
    });
});
