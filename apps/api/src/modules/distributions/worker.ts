import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import {
    createPublicClient,
    createWalletClient,
    getAddress,
    http,
    keccak256,
    parseAbi,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { StartupConfig } from "../../config.js";
import { chain, epochHash, rpcUrl } from "./service.js";

const assetAbi = parseAbi([
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
]);
const vaultAbi = parseAbi([
    "function epochId() view returns (bytes32)",
    "function entitlementRoot() view returns (bytes32)",
    "function committedAmount() view returns (uint256)",
    "function deploymentChainId() view returns (uint256)",
    "function asset() view returns (address)",
    "function participationToken() view returns (address)",
    "function operator() view returns (address)",
    "function fundedAmount() view returns (uint256)",
    "function claimedAmount() view returns (uint256)",
    "function claimable() view returns (bool)",
    "function fund(uint256)",
    "function openClaims()",
]);
const BASE_SEPOLIA_TEST_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

type Job = {
    id: string;
    operation_id: string;
    event_type: "DISTRIBUTION_FUND_REQUESTED" | "DISTRIBUTION_OPEN_REQUESTED";
    epoch_id: string;
    state: string;
    entitlement_root: Hex;
    pool_test_usdc_minor: string;
    vault_address: `0x${string}` | null;
    record_block: string;
    record_block_hash: Hex;
};
export type DistributionWorkerSettings = {
    privateKey: Hex;
    assetAddress: `0x${string}`;
    assetCodeHash?: Hex;
};

async function acquire(pool: Pool): Promise<Job | null> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query<Job>(
            `SELECT o.id,o.operation_id,o.event_type,(o.payload->>'resourceId') AS epoch_id,
                    e.state,e.entitlement_root,e.pool_test_usdc_minor::text,e.vault_address,
                    e.record_block::text,e.record_block_hash
             FROM outbox_events o JOIN distribution_epochs e ON e.id=(o.payload->>'resourceId')::uuid
             WHERE o.status='PENDING' AND o.event_type IN ('DISTRIBUTION_FUND_REQUESTED','DISTRIBUTION_OPEN_REQUESTED')
             ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1`,
        );
        const job = result.rows[0] ?? null;
        if (job)
            await client.query(
                "UPDATE outbox_events SET status='PROCESSING',attempts=attempts+1,updated_at=now() WHERE id=$1",
                [job.id],
            );
        await client.query("COMMIT");
        return job;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function processOneDistribution(
    pool: Pool,
    config: StartupConfig,
    settings: DistributionWorkerSettings,
): Promise<"IDLE" | "CONFIRMED" | "RECONCILIATION_REQUIRED"> {
    const job = await acquire(pool);
    if (!job) return "IDLE";
    const steps: {
        step: string;
        txHash: Hex;
        blockNumber: string;
        blockHash: Hex;
        address: `0x${string}`;
    }[] = [];
    let vaultAddress = job.vault_address;
    try {
        if (!config.TEPA_TOKEN_ADDRESS) throw new Error("TEPA_TOKEN_ADDRESS is required");
        if (config.APP_ENV === "demo" && !settings.assetCodeHash)
            throw new Error("Demo asset code hash is required");
        const publicClient = createPublicClient({ chain: chain(config), transport: http(rpcUrl(config)) });
        const account = privateKeyToAccount(settings.privateKey);
        const walletClient = createWalletClient({
            account,
            chain: chain(config),
            transport: http(rpcUrl(config)),
        });
        if ((await publicClient.getChainId()) !== config.CHAIN_ID) throw new Error("Wrong RPC chain");
        const assetAddress = getAddress(settings.assetAddress);
        const tokenAddress = getAddress(config.TEPA_TOKEN_ADDRESS);
        if (config.APP_ENV === "demo" && assetAddress !== getAddress(BASE_SEPOLIA_TEST_USDC))
            throw new Error("Demo must use Circle's Base Sepolia test USDC address");
        const assetCode = await publicClient.getCode({ address: assetAddress });
        const tokenCode = await publicClient.getCode({ address: tokenAddress });
        if (!assetCode || assetCode === "0x" || !tokenCode || tokenCode === "0x")
            throw new Error("Configured contract code missing");
        if (
            settings.assetCodeHash &&
            keccak256(assetCode).toLowerCase() !== settings.assetCodeHash.toLowerCase()
        )
            throw new Error("Test USDC bytecode hash mismatch");
        if (
            (await publicClient.readContract({
                address: assetAddress,
                abi: assetAbi,
                functionName: "decimals",
            })) !== 6 ||
            (await publicClient.readContract({
                address: assetAddress,
                abi: assetAbi,
                functionName: "symbol",
            })) !== "USDC"
        )
            throw new Error("Asset is not a six-decimal test USDC contract");
        const recordBlock = await publicClient.getBlock({ blockNumber: BigInt(job.record_block) });
        if (recordBlock.hash !== job.record_block_hash) throw new Error("Record-date block reorged");
        const amount = BigInt(job.pool_test_usdc_minor);
        const confirmations = config.CHAIN_ID === 84532 ? 3 : 1;
        const wait = async (txHash: Hex, step: string, address: `0x${string}`) => {
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations });
            if (receipt.status !== "success") throw new Error(`${step} transaction reverted`);
            const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
            if (canonical.hash !== receipt.blockHash) throw new Error(`${step} transaction reorged`);
            steps.push({
                step,
                txHash,
                blockNumber: receipt.blockNumber.toString(),
                blockHash: receipt.blockHash,
                address,
            });
            return receipt;
        };
        if (job.event_type === "DISTRIBUTION_FUND_REQUESTED") {
            if (job.state !== "SNAPSHOTTED") throw new Error("Epoch is not snapshotted");
            if (!vaultAddress) {
                const artifact = JSON.parse(
                    readFileSync(
                        new URL(
                            "../../../../../smart-contract/out/DistributionVault.sol/DistributionVault.json",
                            import.meta.url,
                        ),
                        "utf8",
                    ),
                ) as { abi: unknown[]; bytecode: { object: Hex } };
                const tx = await walletClient.deployContract({
                    abi: artifact.abi,
                    bytecode: artifact.bytecode.object,
                    args: [
                        assetAddress,
                        tokenAddress,
                        epochHash(job.epoch_id),
                        job.entitlement_root,
                        amount,
                        account.address,
                        BigInt(config.CHAIN_ID),
                    ],
                });
                const receipt = await wait(tx, "VAULT_DEPLOY", account.address);
                if (!receipt.contractAddress) throw new Error("Vault deployment had no address");
                vaultAddress = receipt.contractAddress;
                steps.at(-1)!.address = vaultAddress;
            }
            const [root, epochId, committed, chainId, asset, token, operator] = await Promise.all([
                publicClient.readContract({
                    address: vaultAddress,
                    abi: vaultAbi,
                    functionName: "entitlementRoot",
                }),
                publicClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: "epochId" }),
                publicClient.readContract({
                    address: vaultAddress,
                    abi: vaultAbi,
                    functionName: "committedAmount",
                }),
                publicClient.readContract({
                    address: vaultAddress,
                    abi: vaultAbi,
                    functionName: "deploymentChainId",
                }),
                publicClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: "asset" }),
                publicClient.readContract({
                    address: vaultAddress,
                    abi: vaultAbi,
                    functionName: "participationToken",
                }),
                publicClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: "operator" }),
            ]);
            if (
                root !== job.entitlement_root ||
                epochId !== epochHash(job.epoch_id) ||
                committed !== amount ||
                chainId !== BigInt(config.CHAIN_ID) ||
                asset.toLowerCase() !== assetAddress.toLowerCase() ||
                token.toLowerCase() !== tokenAddress.toLowerCase() ||
                operator.toLowerCase() !== account.address.toLowerCase()
            )
                throw new Error("Vault deployment does not match approved epoch");
            const funded = await publicClient.readContract({
                address: vaultAddress,
                abi: vaultAbi,
                functionName: "fundedAmount",
            });
            if (funded > amount) throw new Error("Vault overfunded");
            const remaining = amount - funded;
            if (remaining > 0n) {
                const balance = await publicClient.readContract({
                    address: assetAddress,
                    abi: assetAbi,
                    functionName: "balanceOf",
                    args: [account.address],
                });
                if (balance < remaining) throw new Error("Operator has insufficient test USDC");
                const allowance = await publicClient.readContract({
                    address: assetAddress,
                    abi: assetAbi,
                    functionName: "allowance",
                    args: [account.address, vaultAddress],
                });
                if (allowance < remaining) {
                    const approval = await walletClient.writeContract({
                        address: assetAddress,
                        abi: assetAbi,
                        functionName: "approve",
                        args: [vaultAddress, remaining],
                    });
                    await wait(approval, "ASSET_APPROVAL", assetAddress);
                }
                const funding = await walletClient.writeContract({
                    address: vaultAddress,
                    abi: vaultAbi,
                    functionName: "fund",
                    args: [remaining],
                });
                await wait(funding, "FUND", vaultAddress);
            }
            if (
                (await publicClient.readContract({
                    address: vaultAddress,
                    abi: vaultAbi,
                    functionName: "fundedAmount",
                })) !== amount ||
                (await publicClient.readContract({
                    address: assetAddress,
                    abi: assetAbi,
                    functionName: "balanceOf",
                    args: [vaultAddress],
                })) < amount
            )
                throw new Error("Vault funding did not reconcile");
        } else {
            if (job.state !== "FUNDED" || !vaultAddress) throw new Error("Epoch is not funded");
            const [root, idOnChain, committed, funded, vaultAsset, vaultToken, operator] = await Promise.all([
                publicClient.readContract({
                    address: vaultAddress,
                    abi: vaultAbi,
                    functionName: "entitlementRoot",
                }),
                publicClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: "epochId" }),
                publicClient.readContract({
                    address: vaultAddress,
                    abi: vaultAbi,
                    functionName: "committedAmount",
                }),
                publicClient.readContract({
                    address: vaultAddress,
                    abi: vaultAbi,
                    functionName: "fundedAmount",
                }),
                publicClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: "asset" }),
                publicClient.readContract({
                    address: vaultAddress,
                    abi: vaultAbi,
                    functionName: "participationToken",
                }),
                publicClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: "operator" }),
            ]);
            if (
                root !== job.entitlement_root ||
                idOnChain !== epochHash(job.epoch_id) ||
                committed !== amount ||
                funded !== amount ||
                vaultAsset.toLowerCase() !== assetAddress.toLowerCase() ||
                vaultToken.toLowerCase() !== tokenAddress.toLowerCase() ||
                operator.toLowerCase() !== account.address.toLowerCase()
            )
                throw new Error("Vault state does not match approved epoch");
            if (
                await publicClient.readContract({
                    address: vaultAddress,
                    abi: vaultAbi,
                    functionName: "claimable",
                })
            )
                throw new Error("Claims already open");
            const opening = await walletClient.writeContract({
                address: vaultAddress,
                abi: vaultAbi,
                functionName: "openClaims",
            });
            await wait(opening, "OPEN", vaultAddress);
            if (
                !(await publicClient.readContract({
                    address: vaultAddress,
                    abi: vaultAbi,
                    functionName: "claimable",
                }))
            )
                throw new Error("Claims did not open");
        }
        const db = await pool.connect();
        try {
            await db.query("BEGIN");
            const epoch = await db.query<{ state: string; vault_address: string | null }>(
                "SELECT state,vault_address FROM distribution_epochs WHERE id=$1 FOR UPDATE",
                [job.epoch_id],
            );
            if (epoch.rows[0]?.state !== job.state || epoch.rows[0]?.vault_address !== job.vault_address)
                throw new Error("Epoch changed while chain action was pending");
            for (const step of steps)
                await db.query(
                    `INSERT INTO distribution_chain_steps(epoch_id,step,chain_id,contract_address,tx_hash,block_number,block_hash)
                 VALUES($1,$2,$3,$4,$5,$6::numeric,$7)`,
                    [
                        job.epoch_id,
                        step.step,
                        config.CHAIN_ID,
                        step.address,
                        step.txHash,
                        step.blockNumber,
                        step.blockHash,
                    ],
                );
            const finalTx = steps.at(-1)?.txHash ?? null;
            if (!finalTx) throw new Error("No chain transaction to reconcile");
            await db.query(
                `UPDATE distribution_epochs SET state=$2,vault_address=$3,
                funding_tx_hash=CASE WHEN $2='FUNDED' THEN $4 ELSE funding_tx_hash END,
                opening_tx_hash=CASE WHEN $2='CLAIMABLE' THEN $4 ELSE opening_tx_hash END,
                version=version+1,updated_at=now() WHERE id=$1`,
                [
                    job.epoch_id,
                    job.event_type === "DISTRIBUTION_FUND_REQUESTED" ? "FUNDED" : "CLAIMABLE",
                    vaultAddress,
                    finalTx,
                ],
            );
            await db.query(
                "UPDATE distribution_operations SET status='CONFIRMED',response=jsonb_set(response,'{status}','\"CONFIRMED\"'::jsonb) WHERE id=$1",
                [job.operation_id],
            );
            await db.query("UPDATE outbox_events SET status='DELIVERED',updated_at=now() WHERE id=$1", [
                job.id,
            ]);
            await db.query(
                `INSERT INTO audit_events(actor_ref,actor_role,action,resource_type,resource_id,source_version,before_hash,after_hash,reason,request_id,formula_version,policy_version,chain_command_id,chain_event_id)
                SELECT 'synthetic:distribution-worker','DISTRIBUTION_OPERATOR',$1,'distribution',$2,'phase3-v1',NULL,$3,'Confirmed chain receipt and vault state',$4,'distribution-largest-remainder-v1','sample-claims-v1',$4,s.id
                FROM distribution_chain_steps s WHERE s.epoch_id=$2 AND s.step=$5`,
                [
                    job.event_type === "DISTRIBUTION_FUND_REQUESTED"
                        ? "DISTRIBUTION_FUNDED"
                        : "DISTRIBUTION_CLAIMS_OPENED",
                    job.epoch_id,
                    finalTx.slice(2),
                    job.operation_id,
                    job.event_type === "DISTRIBUTION_FUND_REQUESTED" ? "FUND" : "OPEN",
                ],
            );
            await db.query("COMMIT");
        } catch (error) {
            await db.query("ROLLBACK");
            throw error;
        } finally {
            db.release();
        }
        return "CONFIRMED";
    } catch {
        const db = await pool.connect();
        try {
            await db.query("BEGIN");
            for (const step of steps)
                await db.query(
                    `INSERT INTO distribution_chain_steps(epoch_id,step,chain_id,contract_address,tx_hash,block_number,block_hash)
                 VALUES($1,$2,$3,$4,$5,$6::numeric,$7) ON CONFLICT (epoch_id,step) DO NOTHING`,
                    [
                        job.epoch_id,
                        step.step,
                        config.CHAIN_ID,
                        step.address,
                        step.txHash,
                        step.blockNumber,
                        step.blockHash,
                    ],
                );
            await db.query(
                "UPDATE outbox_events SET status='RECONCILIATION_REQUIRED',updated_at=now() WHERE id=$1",
                [job.id],
            );
            await db.query(
                "UPDATE distribution_operations SET status='RECONCILIATION_REQUIRED',response=jsonb_set(response,'{status}','\"RECONCILIATION_REQUIRED\"'::jsonb) WHERE id=$1",
                [job.operation_id],
            );
            await db.query(
                "UPDATE distribution_epochs SET state='RECONCILIATION_REQUIRED',vault_address=COALESCE(vault_address,$2),updated_at=now() WHERE id=$1",
                [job.epoch_id, vaultAddress],
            );
            await db.query(
                "INSERT INTO distribution_reconciliation_incidents(epoch_id,operation_id,code,evidence) VALUES($1,$2,'CHAIN_ACTION_FAILED',$3::jsonb)",
                [
                    job.epoch_id,
                    job.operation_id,
                    JSON.stringify({
                        step: job.event_type,
                        vaultAddress,
                        confirmedSteps: steps.map((step) => ({
                            step: step.step,
                            txHash: step.txHash,
                            blockHash: step.blockHash,
                        })),
                    }),
                ],
            );
            await db.query("COMMIT");
        } catch (error) {
            await db.query("ROLLBACK");
            throw error;
        } finally {
            db.release();
        }
        return "RECONCILIATION_REQUIRED";
    }
}

export async function recheckDistributionEvidence(pool: Pool, config: StartupConfig): Promise<number> {
    const publicClient = createPublicClient({ chain: chain(config), transport: http(rpcUrl(config)) });
    if ((await publicClient.getChainId()) !== config.CHAIN_ID) throw new Error("Wrong RPC chain");
    const rows = await pool.query<{
        id: string;
        state: string;
        vault_address: `0x${string}` | null;
        entitlement_root: Hex | null;
        pool_test_usdc_minor: string;
        record_block: string | null;
        record_block_hash: Hex | null;
    }>(
        `SELECT id,state,vault_address,entitlement_root,pool_test_usdc_minor::text,record_block::text,record_block_hash
         FROM distribution_epochs WHERE state IN ('SNAPSHOTTED','FUNDED','CLAIMABLE')`,
    );
    let flagged = 0;
    for (const epoch of rows.rows) {
        let mismatch = false;
        try {
            if (epoch.record_block && epoch.record_block_hash) {
                const block = await publicClient.getBlock({ blockNumber: BigInt(epoch.record_block) });
                mismatch ||= block.hash !== epoch.record_block_hash;
            }
            const steps = await pool.query<{ block_number: string; block_hash: Hex; tx_hash: Hex }>(
                "SELECT block_number::text,block_hash,tx_hash FROM distribution_chain_steps WHERE epoch_id=$1",
                [epoch.id],
            );
            for (const step of steps.rows) {
                const receipt = await publicClient.getTransactionReceipt({ hash: step.tx_hash });
                mismatch ||=
                    receipt.status !== "success" ||
                    receipt.blockHash !== step.block_hash ||
                    receipt.blockNumber !== BigInt(step.block_number);
            }
            if (epoch.vault_address) {
                const [root, funded, claimable] = await Promise.all([
                    publicClient.readContract({
                        address: epoch.vault_address,
                        abi: vaultAbi,
                        functionName: "entitlementRoot",
                    }),
                    publicClient.readContract({
                        address: epoch.vault_address,
                        abi: vaultAbi,
                        functionName: "fundedAmount",
                    }),
                    publicClient.readContract({
                        address: epoch.vault_address,
                        abi: vaultAbi,
                        functionName: "claimable",
                    }),
                ]);
                mismatch ||=
                    root !== epoch.entitlement_root ||
                    (epoch.state !== "SNAPSHOTTED" && funded !== BigInt(epoch.pool_test_usdc_minor)) ||
                    (epoch.state === "CLAIMABLE" && !claimable);
            } else if (epoch.state === "FUNDED" || epoch.state === "CLAIMABLE") mismatch = true;
            const claims = await pool.query<{ tx_hash: Hex; block_hash: Hex; log_index: number }>(
                `SELECT c.tx_hash,c.block_hash,c.log_index FROM distribution_claims c
                 JOIN distribution_entitlements e ON e.id=c.entitlement_id WHERE e.epoch_id=$1`,
                [epoch.id],
            );
            for (const claim of claims.rows) {
                const receipt = await publicClient.getTransactionReceipt({ hash: claim.tx_hash });
                mismatch ||=
                    receipt.status !== "success" ||
                    receipt.blockHash !== claim.block_hash ||
                    !receipt.logs.some(
                        (log) =>
                            log.logIndex === claim.log_index &&
                            log.address.toLowerCase() === epoch.vault_address?.toLowerCase(),
                    );
            }
        } catch {
            mismatch = true;
        }
        if (mismatch) {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const update = await client.query(
                    "UPDATE distribution_epochs SET state='RECONCILIATION_REQUIRED',updated_at=now() WHERE id=$1 AND state=$2",
                    [epoch.id, epoch.state],
                );
                if (update.rowCount) {
                    await client.query(
                        "INSERT INTO distribution_reconciliation_incidents(epoch_id,code,evidence) VALUES($1,'CHAIN_EVIDENCE_MISMATCH',$2::jsonb)",
                        [epoch.id, JSON.stringify({ previousState: epoch.state })],
                    );
                    flagged++;
                }
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }
        }
    }
    return flagged;
}
