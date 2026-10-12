import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { parseStartupConfig } from "../../config.js";
import { createApp } from "../../app.js";
import { migrate } from "../../migrate.js";
import { subjectHash } from "../eligibility/service.js";
import {
    advanceAcquisition,
    advanceBuyback,
    allocateBuybackCase,
    approveAppraisal,
    getSettlements,
    prepareAcquisition,
    prepareAppraisal,
    prepareBuyback,
    recordSettlementReceipt,
    requestSettlementStep,
    resumeSettlement,
    snapshotAcquisition,
    submitTender,
} from "./service.js";
import { processOneSettlement } from "./worker.js";
import { settleInLocalBrowser } from "../distributions/browser-claim.test-helper.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const tokenAbi = parseAbi([
    "function COMPLIANCE_ROLE() view returns (bytes32)",
    "function ISSUER_AGENT_ROLE() view returns (bytes32)",
    "function grantRole(bytes32,address)",
    "function setEligibility(address,bytes32,bytes32,uint64,bool)",
    "function recordAllocation(bytes32,address,uint16,bytes32)",
    "function mint(bytes32,address,uint16,bytes32)",
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function terminalSettlement() view returns (bool)",
]);
const assetAbi = parseAbi([
    "function mint(address,uint256)",
    "function balanceOf(address) view returns (uint256)",
]);
const vaultAbi = parseAbi(["function settle(uint256,uint256,uint256,bytes32[])"]);
async function freePort() {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return address.port;
}

describe.skipIf(!databaseUrl)("Phase 4 funded settlement", () => {
    let pool: pg.Pool;
    let anvil: ChildProcess;
    let rpc: string;
    let tokenAddress: `0x${string}`;
    let assetAddress: `0x${string}`;
    let issuerId: string;
    const signerKey = generatePrivateKey();
    const signer = privateKeyToAccount(signerKey);
    const holderKeys = [generatePrivateKey(), generatePrivateKey()];
    const holders = holderKeys.map((key) => privateKeyToAccount(key));
    const config = () =>
        parseStartupConfig({
            APP_ENV: "test",
            DATABASE_URL: databaseUrl,
            CHAIN_RPC_URL: rpc,
            TEPA_TOKEN_ADDRESS: tokenAddress,
            TEST_USDC_ADDRESS: assetAddress,
        });
    const publicClient = () => createPublicClient({ chain: foundry, transport: http(rpc) });
    const wallet = () => createWalletClient({ account: signer, chain: foundry, transport: http(rpc) });
    const actor = (
        role: "ISSUER_PREPARER" | "FINANCE_REVIEWER" | "DISTRIBUTION_OPERATOR" | "INVESTOR_A" | "INVESTOR_B",
    ) => ({
        role,
        actorRef: `synthetic:${role.toLowerCase()}`,
    });
    const mutation = async (role: Parameters<typeof actor>[0], action: string, body: unknown = {}) => ({
        actor: actor(role),
        action,
        body,
        key: randomUUID(),
        reason: "Reviewed fictional Phase 4 workflow",
        expectedVersion: (
            await pool.query<{ version: number }>("SELECT version FROM issuers WHERE id=$1", [issuerId])
        ).rows[0]!.version,
    });
    async function deploy(name: string, args: unknown[]) {
        const artifact = JSON.parse(
            readFileSync(
                new URL(`../../../../../smart-contract/out/${name}.sol/${name}.json`, import.meta.url),
                "utf8",
            ),
        ) as { abi: unknown[]; bytecode: { object: Hex } };
        const tx = await wallet().deployContract({
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            args,
        });
        const receipt = await publicClient().waitForTransactionReceipt({ hash: tx });
        if (!receipt.contractAddress) throw new Error("No deployed address");
        return receipt.contractAddress;
    }

    beforeAll(async () => {
        await migrate(databaseUrl!);
        pool = new pg.Pool({ connectionString: databaseUrl });
        await pool.query(`TRUNCATE phase4_chain_steps,phase4_operations,phase4_receipts,phase4_allocations,phase4_tenders,
            phase4_cases,phase4_appraisals,distribution_chain_steps,distribution_operations,distribution_claims,
            distribution_entitlements,distribution_epochs,phase2_chain_steps,phase2_operations,wallet_challenges,
            phase2_holders,prototype_terms,financial_operations,financial_approvals,financial_review_cases,
            customer_metric_rows,financial_source_rows,financial_imports,issuers,audit_events,outbox_events CASCADE`);
        rpc = `http://127.0.0.1:${await freePort()}`;
        anvil = spawn("anvil", ["--port", new URL(rpc).port, "--chain-id", "31337", "--silent"], {
            stdio: "ignore",
        });
        for (let i = 0; i < 50; i++) {
            try {
                if ((await publicClient().getChainId()) === 31337) break;
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }
        for (const account of [signer, ...holders])
            await publicClient().request({
                method: "anvil_setBalance",
                params: [account.address, "0x3635C9ADC5DEA00000"],
            } as Parameters<ReturnType<typeof publicClient>["request"]>[0]);
        tokenAddress = await deploy("TepaToken", [signer.address, 31337]);
        assetAddress = await deploy("TestUsdc", []);
        for (const role of ["COMPLIANCE_ROLE", "ISSUER_AGENT_ROLE"] as const) {
            const value = await publicClient().readContract({
                address: tokenAddress,
                abi: tokenAbi,
                functionName: role,
            });
            const tx = await wallet().writeContract({
                address: tokenAddress,
                abi: tokenAbi,
                functionName: "grantRole",
                args: [value, signer.address],
            });
            await publicClient().waitForTransactionReceipt({ hash: tx });
        }
        for (const [index, holder] of holders.entries()) {
            const ref = index === 0 ? "synthetic-holder-a" : "synthetic-holder-b";
            const subject = subjectHash(ref);
            const caseId = `0x${"1".repeat(63)}${index + 1}` as Hex;
            for (const [functionName, args] of [
                [
                    "setEligibility",
                    [holder.address, subject, caseId, BigInt(Math.floor(Date.now() / 1000) + 86400), true],
                ],
                ["recordAllocation", [subject, holder.address, index === 0 ? 600 : 400, caseId]],
                ["mint", [subject, holder.address, index === 0 ? 600 : 400, caseId]],
            ] as const) {
                const tx = await wallet().writeContract({
                    address: tokenAddress,
                    abi: tokenAbi,
                    functionName,
                    args,
                });
                await publicClient().waitForTransactionReceipt({ hash: tx });
            }
        }
        const mint = await wallet().writeContract({
            address: assetAddress,
            abi: assetAbi,
            functionName: "mint",
            args: [signer.address, 300_000_000_000n],
        });
        await publicClient().waitForTransactionReceipt({ hash: mint });
        issuerId = (
            await pool.query<{ id: string }>(
                "INSERT INTO issuers(public_id,display_name) VALUES('example-saas','Example SaaS, Inc.') RETURNING id",
            )
        ).rows[0]!.id;
        const terms = (
            await pool.query<{ id: string }>(
                "INSERT INTO prototype_terms(issuer_id,version,terms,sha256,published_by) VALUES($1,1,'{}',$2,'synthetic:issuer') RETURNING id",
                [issuerId, "a".repeat(64)],
            )
        ).rows[0]!.id;
        for (const [index, holder] of holders.entries()) {
            const ref = index === 0 ? "synthetic-holder-a" : "synthetic-holder-b";
            await pool.query(
                `INSERT INTO phase2_holders(issuer_id,holder_ref,subject_hash,planned_units,terms_id,
                eligibility_status,eligibility_decision_id,eligibility_expires_at,jurisdiction,wallet_address,
                subscription_status,recorded_units) VALUES($1,$2,$3,$4,$5,'APPROVED',$6,now()+interval '1 day',
                'US',$7,'RECORDED',$4)`,
                [
                    issuerId,
                    ref,
                    subjectHash(ref),
                    index === 0 ? 600 : 400,
                    terms,
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

    it("allocates oversubscription, burns only paid units, and finalizes acquisition on remaining balances", async () => {
        const api = createApp(config(), pool).listen(0);
        try {
            const address = api.address();
            if (!address || typeof address === "string") throw new Error("API did not bind");
            const base = `http://127.0.0.1:${address.port}`;
            const session = await fetch(`${base}/demo/session`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ role: "INVESTOR_A" }),
            });
            const { token } = (await session.json()) as { token: string };
            const forbidden = await fetch(`${base}/api/v1/appraisals`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: "{}",
            });
            expect(forbidden.status).toBe(403);
        } finally {
            await new Promise<void>((resolve) => api.close(() => resolve()));
        }
        const appraisal = {
            appraisedEquityUsdMinor: "200000000",
            participationBasisPoints: 1000,
            outstandingEligibleUnits: "1000",
            valuationDate: "2026-09-23",
            methodology: "Independent fictional sample appraisal",
            evidenceRef: "sample-appraisal-v1",
            assumptions: {
                cashAndDebt: "Included in equity value",
                dilution: "No new financing",
                pastDistributions: "Past distributions separate",
                tepaObligation: "BEFORE_TEPA_ALLOCATION" as const,
            },
        };
        const prepareInput = await mutation("ISSUER_PREPARER", "APPRAISAL_PREPARE", appraisal);
        const prepared = await prepareAppraisal(pool, prepareInput, appraisal);
        expect(await prepareAppraisal(pool, prepareInput, appraisal)).toEqual(prepared);
        const appraisalId = (prepared as Record<string, unknown>).appraisalId as string;
        await approveAppraisal(
            pool,
            await mutation("FINANCE_REVIEWER", `APPRAISAL_APPROVE:${appraisalId}`),
            appraisalId,
        );
        const details = {
            appraisalId,
            budgetUsdMinor: "10000000",
            bindingUnitPriceUsdMinor: "20000",
            tenderDeadline: new Date(Date.now() + 1500).toISOString(),
        };
        const created = await prepareBuyback(
            pool,
            await mutation("ISSUER_PREPARER", "BUYBACK_PREPARE", details),
            details,
        );
        const buybackId = (created as Record<string, unknown>).caseId as string;
        await advanceBuyback(
            pool,
            await mutation("FINANCE_REVIEWER", `BUYBACK_APPROVED:${buybackId}`),
            buybackId,
            "APPROVED",
        );
        await advanceBuyback(
            pool,
            await mutation("ISSUER_PREPARER", `BUYBACK_OPEN:${buybackId}`),
            buybackId,
            "OPEN",
        );
        const tenderApi = createApp(config(), pool).listen(0);
        try {
            const address = tenderApi.address();
            if (!address || typeof address === "string") throw new Error("API did not bind");
            const base = `http://127.0.0.1:${address.port}`;
            const session = await fetch(`${base}/demo/session`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ role: "DISTRIBUTION_OPERATOR" }),
            });
            const { token } = (await session.json()) as { token: string };
            const forbidden = await fetch(`${base}/api/v1/buybacks/${buybackId}/tenders`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                    "If-Match": String(
                        (await mutation("DISTRIBUTION_OPERATOR", "TENDER_FORBIDDEN")).expectedVersion,
                    ),
                    "Idempotency-Key": randomUUID(),
                    "X-Action-Reason": "Operator cannot submit a holder tender",
                },
                body: JSON.stringify({ units: 1 }),
            });
            expect(forbidden.status).toBe(403);
        } finally {
            await new Promise<void>((resolve) => tenderApi.close(() => resolve()));
        }
        await expect(
            submitTender(
                pool,
                await mutation("INVESTOR_A", `TENDER:${buybackId}`, { units: 601 }),
                buybackId,
                601,
            ),
        ).rejects.toThrow("Tender exceeds remaining units");
        await submitTender(
            pool,
            await mutation("INVESTOR_A", `TENDER:${buybackId}`, { units: 400 }),
            buybackId,
            400,
        );
        await submitTender(
            pool,
            await mutation("INVESTOR_B", `TENDER:${buybackId}`, { units: 400 }),
            buybackId,
            400,
        );
        await new Promise((resolve) => setTimeout(resolve, 1550));
        await advanceBuyback(
            pool,
            await mutation("DISTRIBUTION_OPERATOR", `BUYBACK_TENDER_CLOSED:${buybackId}`),
            buybackId,
            "TENDER_CLOSED",
        );
        const allocated = await allocateBuybackCase(
            pool,
            config(),
            await mutation("DISTRIBUTION_OPERATOR", `BUYBACK_ALLOCATE:${buybackId}`),
            buybackId,
        );
        const result = (allocated as Record<string, unknown>).allocation as {
            acceptedUnits: string;
            allocations: { acceptedUnits: string }[];
        };
        expect(result.acceptedUnits).toBe("500");
        expect(result.allocations.map((row) => row.acceptedUnits)).toEqual(["250", "250"]);
        await requestSettlementStep(
            pool,
            await mutation("DISTRIBUTION_OPERATOR", `SETTLEMENT_FUND:${buybackId}`),
            buybackId,
            "FUND",
        );
        expect(
            await processOneSettlement(pool, config(), {
                privateKey: signerKey,
                assetAddress: "0x0000000000000000000000000000000000000001",
            }),
        ).toBe("RECONCILIATION_REQUIRED");
        expect(
            (await getSettlements(pool, actor("FINANCE_REVIEWER"))).cases.find((row) => row.id === buybackId)
                ?.state,
        ).toBe("RECONCILIATION_REQUIRED");
        await resumeSettlement(
            pool,
            await mutation("DISTRIBUTION_OPERATOR", `SETTLEMENT_RESUME:${buybackId}`),
            buybackId,
        );
        expect(await processOneSettlement(pool, config(), { privateKey: signerKey, assetAddress })).toBe(
            "CONFIRMED",
        );
        const buyback = (await getSettlements(pool, actor("INVESTOR_A"))).cases.find(
            (row) => row.id === buybackId,
        )!;
        expect(buyback.state).toBe("FUNDED");
        if (process.env.BROWSER_BIN) {
            await settleInLocalBrowser({
                pool,
                databaseUrl: databaseUrl!,
                rpcUrl: rpc,
                tokenAddress,
                assetAddress,
                holderKeys,
                browserBin: process.env.BROWSER_BIN,
                settlementCaseId: buybackId,
            });
        } else {
            for (const [index, holder] of holders.entries()) {
                const ownView = (
                    await getSettlements(pool, actor(index === 0 ? "INVESTOR_A" : "INVESTOR_B"))
                ).cases.find((row) => row.id === buybackId)!;
                const own = ownView.allocations.find(
                    (row) => row.holder_ref === (index === 0 ? "synthetic-holder-a" : "synthetic-holder-b"),
                )! as {
                    leaf_index: number;
                    accepted_units: number;
                    amount_test_usdc_minor: string;
                    proof: Hex[];
                };
                const holderWallet = createWalletClient({
                    account: holder,
                    chain: foundry,
                    transport: http(rpc),
                });
                const tx = await holderWallet.writeContract({
                    address: buyback.vault_address!,
                    abi: vaultAbi,
                    functionName: "settle",
                    args: [
                        BigInt(own.leaf_index),
                        BigInt(own.accepted_units),
                        BigInt(own.amount_test_usdc_minor),
                        own.proof,
                    ],
                });
                expect((await publicClient().waitForTransactionReceipt({ hash: tx })).status).toBe("success");
                await recordSettlementReceipt(
                    pool,
                    config(),
                    await mutation(
                        index === 0 ? "INVESTOR_A" : "INVESTOR_B",
                        `SETTLEMENT_RECEIPT:${buybackId}`,
                        {
                            txHash: tx,
                        },
                    ),
                    buybackId,
                    tx,
                );
            }
        }
        const buybackReceipts = await pool.query(
            `SELECT r.id FROM phase4_receipts r JOIN phase4_allocations a ON a.id=r.allocation_id
             WHERE a.case_id=$1`,
            [buybackId],
        );
        expect(buybackReceipts.rows).toHaveLength(2);
        expect(
            (await getSettlements(pool, actor("FINANCE_REVIEWER"))).cases.find((row) => row.id === buybackId)
                ?.state,
        ).toBe("SETTLED");
        await requestSettlementStep(
            pool,
            await mutation("DISTRIBUTION_OPERATOR", `SETTLEMENT_FINALIZE:${buybackId}`),
            buybackId,
            "FINALIZE",
        );
        expect(await processOneSettlement(pool, config(), { privateKey: signerKey, assetAddress })).toBe(
            "CONFIRMED",
        );
        expect(
            await publicClient().readContract({
                address: tokenAddress,
                abi: tokenAbi,
                functionName: "totalSupply",
            }),
        ).toBe(500n);
        const waterfall = {
            grossConsiderationUsdMinor: "100000000",
            transactionCostsUsdMinor: "10000000",
            debtAndSeniorObligationsUsdMinor: "10000000",
            taxesAndRequiredReservesUsdMinor: "10000000",
            disclosedOtherDeductionsUsdMinor: "0",
            otherDeductionsDescription: "",
            participationBasisPoints: 1000,
        };
        const acq = await prepareAcquisition(
            pool,
            await mutation("ISSUER_PREPARER", "ACQUISITION_PREPARE", waterfall),
            waterfall,
        );
        const acqId = (acq as Record<string, unknown>).caseId as string;
        await advanceAcquisition(
            pool,
            await mutation("FINANCE_REVIEWER", `ACQUISITION_EVIDENCE_REVIEW:${acqId}`),
            acqId,
            "EVIDENCE_REVIEW",
        );
        await advanceAcquisition(
            pool,
            await mutation("FINANCE_REVIEWER", `ACQUISITION_APPROVED:${acqId}`),
            acqId,
            "APPROVED",
        );
        await snapshotAcquisition(
            pool,
            config(),
            await mutation("DISTRIBUTION_OPERATOR", `ACQUISITION_SNAPSHOT:${acqId}`),
            acqId,
        );
        await requestSettlementStep(
            pool,
            await mutation("DISTRIBUTION_OPERATOR", `SETTLEMENT_FUND:${acqId}`),
            acqId,
            "FUND",
        );
        expect(await processOneSettlement(pool, config(), { privateKey: signerKey, assetAddress })).toBe(
            "CONFIRMED",
        );
        if (process.env.BROWSER_BIN) {
            await settleInLocalBrowser({
                pool,
                databaseUrl: databaseUrl!,
                rpcUrl: rpc,
                tokenAddress,
                assetAddress,
                holderKeys,
                browserBin: process.env.BROWSER_BIN,
                settlementCaseId: acqId,
            });
        } else {
            for (const [index, holder] of holders.entries()) {
                const view = (
                    await getSettlements(pool, actor(index === 0 ? "INVESTOR_A" : "INVESTOR_B"))
                ).cases.find((row) => row.id === acqId)!;
                const own = view.allocations.find(
                    (row) => row.holder_ref === (index === 0 ? "synthetic-holder-a" : "synthetic-holder-b"),
                )! as {
                    leaf_index: number;
                    accepted_units: number;
                    amount_test_usdc_minor: string;
                    proof: Hex[];
                };
                const tx = await createWalletClient({
                    account: holder,
                    chain: foundry,
                    transport: http(rpc),
                }).writeContract({
                    address: view.vault_address!,
                    abi: vaultAbi,
                    functionName: "settle",
                    args: [
                        BigInt(own.leaf_index),
                        BigInt(own.accepted_units),
                        BigInt(own.amount_test_usdc_minor),
                        own.proof,
                    ],
                });
                expect((await publicClient().waitForTransactionReceipt({ hash: tx })).status).toBe("success");
                await recordSettlementReceipt(
                    pool,
                    config(),
                    await mutation(index === 0 ? "INVESTOR_A" : "INVESTOR_B", `SETTLEMENT_RECEIPT:${acqId}`, {
                        txHash: tx,
                    }),
                    acqId,
                    tx,
                );
            }
        }
        const acquisitionReceipts = await pool.query(
            `SELECT r.id FROM phase4_receipts r JOIN phase4_allocations a ON a.id=r.allocation_id
             WHERE a.case_id=$1`,
            [acqId],
        );
        expect(acquisitionReceipts.rows).toHaveLength(2);
        await requestSettlementStep(
            pool,
            await mutation("DISTRIBUTION_OPERATOR", `SETTLEMENT_FINALIZE:${acqId}`),
            acqId,
            "FINALIZE",
        );
        expect(await processOneSettlement(pool, config(), { privateKey: signerKey, assetAddress })).toBe(
            "CONFIRMED",
        );
        expect(
            await publicClient().readContract({
                address: tokenAddress,
                abi: tokenAbi,
                functionName: "totalSupply",
            }),
        ).toBe(0n);
        expect(
            await publicClient().readContract({
                address: tokenAddress,
                abi: tokenAbi,
                functionName: "terminalSettlement",
            }),
        ).toBe(true);
        const chainAudit = await pool.query(
            `SELECT action,chain_command_id,chain_event_id FROM audit_events
             WHERE action IN ('BUYBACK_FUNDED','BUYBACK_PAYMENT_RECORDED','BUYBACK_FINALIZED',
                              'ACQUISITION_FUNDED','ACQUISITION_PAYMENT_RECORDED','ACQUISITION_FINALIZED')`,
        );
        expect(chainAudit.rows).toHaveLength(8);
        expect(chainAudit.rows.every((row) => row.chain_command_id && row.chain_event_id)).toBe(true);
        await expect(
            prepareAcquisition(
                pool,
                await mutation("ISSUER_PREPARER", "ACQUISITION_PREPARE_AGAIN", waterfall),
                waterfall,
            ),
        ).rejects.toThrow("final");
    }, 60000);
});
