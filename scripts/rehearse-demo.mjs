#!/usr/bin/env node
// TEPA reviewer-path rehearsal on local Anvil (chain 31337).
//
// Replays the README reviewer path through the same API calls the /demo panels make.
// Holder wallet actions (challenge signature, claims, settlements) are signed with local Anvil test
// keys as a stand-in for the wallet extension. This is an API and chain check, not a browser or
// extension-wallet rehearsal.
//
// Usage (from the repository root, with apps/api/.env.anvil exported, `npm run dev` and
// `npm run demo:work` running, and local contracts deployed):
//
//   export DEMO_HOLDER_A_PRIVATE_KEY=... DEMO_HOLDER_B_PRIVATE_KEY=...   # local-only Anvil keys
//   node scripts/rehearse-demo.mjs [--phases=A,B,C,D,E,F,G] [--strict-audit] [--stop-after=<checkpoint>]
//
// Phases: A reconciliation, B eligibility and issuance, C prohibited transfers, D 2025-Q1
// distribution, E appraisal and buyback, F acquisition, G audit explorer.
// The script resumes a partially completed scene and skips steps already recorded. It refuses a
// finalized scene; run the guarded `npm run demo:reset` first. It never prints private keys.
// --stop-after stops the scene at a recording checkpoint so the presenter continues live in the
// browser: cash (after A), issuance (after B, before the transfer checks), distribution-open (claims
// open, nothing claimed), buyback-open (window open, no tenders), acquisition-ready (acquisition vault
// funded and open, nothing settled). Rerun with a later checkpoint, or none, to resume from there.
// With buyback-open the tender window defaults to 300 s so tenders can be recorded live.
// --strict-audit fails when chain-backed audit events lack chain_command_id/chain_event_id;
// without it that check is reported as a known gap.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
    BaseError,
    ContractFunctionRevertedError,
    createPublicClient,
    createTestClient,
    createWalletClient,
    getAddress,
    http,
    parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}`));
const phases = new Set((flag("phases")?.split("=")[1] ?? "A,B,C,D,E,F,G").split(","));
const strictAudit = Boolean(flag("strict-audit"));
// Recording checkpoints, in scene order, with the phase each belongs to and what the presenter does next.
const CHECKPOINTS = {
    cash: ["A", "Financial preview approved. Next, live: terms, eligibility, wallet binding, issuance."],
    issuance: ["B", "600/400 units minted and recorded. Next, live: the blocked A-to-B transfer."],
    "distribution-open": ["D", "2025-Q1 claims are open and unclaimed. Next, live: holder claims."],
    "buyback-open": ["E", "Buyback window is open with no tenders. Next, live: tenders, then settlement."],
    "acquisition-ready": ["F", "Acquisition vault is funded and open. Next, live: holder settlements."],
};
const stopAfter = flag("stop-after")?.split("=")[1];
const env = process.env;
const API = env.TEPA_API_URL ?? "http://localhost:3000";
const RPC = env.CHAIN_RPC_URL;
const tenderSeconds = Number(env.REHEARSAL_TENDER_SECONDS ?? (stopAfter === "buyback-open" ? 300 : 75));
const fixture = JSON.parse(
    readFileSync(new URL("../data/fixtures/settlement/sample.v1.json", import.meta.url), "utf8"),
);

const results = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = "") {
    results.push({ name, ok });
    log(ok ? "PASS" : "FAIL", name, detail);
    if (!ok) throw new Error(`Check failed: ${name}`);
}
function skip(name, why) {
    results.push({ name, ok: true, skipped: true });
    log("SKIP", name, `(${why})`);
}
function fail(message) {
    console.error(`rehearse-demo: ${message}`);
    process.exit(2);
}
function summary() {
    const passed = results.filter((r) => r.ok && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    log(`== ${passed} checks passed, ${skipped} skipped or reported, 0 failed`);
}
// Stop here when this is the requested checkpoint. The scene keeps its state; a later run resumes it.
function checkpoint(name) {
    if (stopAfter !== name) return;
    log(`== Stopped at checkpoint ${name}. ${CHECKPOINTS[name][1]}`);
    summary();
    process.exit(0);
}
if (stopAfter !== undefined) {
    if (!CHECKPOINTS[stopAfter]) fail(`--stop-after must be one of: ${Object.keys(CHECKPOINTS).join(", ")}.`);
    if (!phases.has(CHECKPOINTS[stopAfter][0]))
        fail(`--stop-after=${stopAfter} needs phase ${CHECKPOINTS[stopAfter][0]} in --phases.`);
}

// ---- Guards: local loopback Anvil only, keys must match the configured demo wallets.
const loopback = (url) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
if (!RPC || !loopback(RPC)) fail("CHAIN_RPC_URL must be a loopback Anvil URL. Export apps/api/.env.anvil.");
if (!loopback(API)) fail("TEPA_API_URL must be a loopback URL.");
for (const name of [
    "TEPA_TOKEN_ADDRESS",
    "TEST_USDC_ADDRESS",
    "DEMO_HOLDER_A_ADDRESS",
    "DEMO_HOLDER_B_ADDRESS",
])
    if (!env[name]) fail(`${name} is not set. Export apps/api/.env.anvil after local deployment.`);
for (const name of ["DEMO_HOLDER_A_PRIVATE_KEY", "DEMO_HOLDER_B_PRIVATE_KEY"])
    if (!/^0x[0-9a-fA-F]{64}$/.test(env[name] ?? ""))
        fail(`${name} must be a local-only 0x-prefixed test key.`);

const TOKEN = getAddress(env.TEPA_TOKEN_ADDRESS);
const USDC = getAddress(env.TEST_USDC_ADDRESS);
const transport = http(RPC);
const pub = createPublicClient({ chain: foundry, transport });
const testClient = createTestClient({ chain: foundry, mode: "anvil", transport });
const HOLDERS = {};
for (const [ref, role, letter] of [
    ["synthetic-holder-a", "INVESTOR_A", "A"],
    ["synthetic-holder-b", "INVESTOR_B", "B"],
]) {
    const account = privateKeyToAccount(env[`DEMO_HOLDER_${letter}_PRIVATE_KEY`]);
    if (account.address !== getAddress(env[`DEMO_HOLDER_${letter}_ADDRESS`]))
        fail(`DEMO_HOLDER_${letter}_PRIVATE_KEY does not control DEMO_HOLDER_${letter}_ADDRESS.`);
    HOLDERS[ref] = {
        role,
        wallet: account.address,
        client: createWalletClient({ account, chain: foundry, transport }),
    };
}
const A = HOLDERS["synthetic-holder-a"];
const B = HOLDERS["synthetic-holder-b"];

const tokenAbi = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function terminalSettlement() view returns (bool)",
    "function transfer(address,uint256) returns (bool)",
    "function transferFrom(address,address,uint256) returns (bool)",
    "function approve(address,uint256) returns (bool)",
    "function mint(bytes32,address,uint16,bytes32)",
    "error Unauthorized()",
    "error RestrictedTransfer()",
    "error TerminalSettlement()",
    "error AlreadyMinted()",
    "error AllocationMismatch()",
    "error Ineligible()",
    "error PausedError()",
]);
const vaultAbi = parseAbi([
    "function claim(uint256,uint256,bytes32[])",
    "function settle(uint256,uint256,uint256,bytes32[])",
    "error Unauthorized()",
    "error InvalidState()",
    "error InvalidProof()",
    "error AlreadyClaimed()",
    "error AlreadySettled()",
    "error Ineligible()",
]);
const usdcAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const read = (address, abi, functionName, a = []) =>
    pub.readContract({ address, abi, functionName, args: a });
const bal = (w) => read(TOKEN, tokenAbi, "balanceOf", [w]);
const usdc = (w) => read(USDC, usdcAbi, "balanceOf", [w]);
const supply = () => read(TOKEN, tokenAbi, "totalSupply");
const mine = (blocks = 3) => testClient.mine({ blocks });

// Simulate a call from `account` and return the custom error name it reverts with, or null on success.
async function revertName(address, abi, functionName, a, account) {
    try {
        await pub.simulateContract({ address, abi, functionName, args: a, account });
        return null;
    } catch (e) {
        const reverted =
            e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
        return reverted?.data?.errorName ?? reverted?.signature ?? "reverted";
    }
}
async function send(holder, address, abi, functionName, a, extra = {}) {
    const hash = await holder.client.writeContract({ address, abi, functionName, args: a, ...extra });
    return { hash, receipt: await pub.waitForTransactionReceipt({ hash }) };
}

// ---- API helpers: simulated local role sessions, idempotency keys, expected versions, reasons.
// Simulated sessions live in API memory; an API restart drops them, so 401s re-create the session once.
const tokens = {};
async function authed(role, fn) {
    const r = await fn(await session(role));
    if (r.status !== 401) return r;
    delete tokens[role];
    return fn(await session(role));
}
async function session(role) {
    if (tokens[role]) return tokens[role];
    const r = await fetch(`${API}/demo/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
    });
    if (!r.ok) throw new Error(`session ${role}: ${r.status}`);
    return (tokens[role] = (await r.json()).token);
}
async function get(path, role = "AUDITOR") {
    const r = await authed(role, (token) =>
        fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } }),
    );
    const body = await r.json();
    if (!r.ok)
        throw Object.assign(new Error(`GET ${path} ${r.status} ${body.code}`), { status: r.status, body });
    return body;
}
const version = async (role) => (await get("/api/v1/phase2", role)).issuerVersion;
async function post(path, body, role, reason, { expectFail = false } = {}) {
    const idempotencyKey = randomUUID();
    const r = await authed(role, async (token) =>
        fetch(`${API}${path}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                "If-Match": String(await version(role)),
                "Idempotency-Key": idempotencyKey,
                "X-Action-Reason": reason,
            },
            body: JSON.stringify(body),
        }),
    );
    const data = await r.json();
    if (expectFail) return { status: r.status, data };
    if (!r.ok) throw new Error(`POST ${path} as ${role} -> ${r.status} ${data.code}: ${data.message}`);
    log(`  ${role} POST ${path} -> ${data.status ?? r.status}`);
    return data;
}
async function until(label, fn, timeoutMs = 180_000) {
    const start = Date.now();
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - start > timeoutMs)
            throw new Error(`Timed out waiting for ${label}. Is npm run demo:work running?`);
        await sleep(2000);
    }
}
// Record a holder receipt the way the UI does: retry while confirmations are pending.
async function recordReceipt(path, txHash, role, reason) {
    for (let i = 0; i < 10; i++) {
        await mine(3);
        const res = await post(path, { txHash }, role, reason, { expectFail: true });
        if (res.status < 300) return res.data;
        if (!/not confirmed|confirmations/i.test(res.data.message ?? ""))
            throw new Error(`${path}: ${res.data.code} ${res.data.message}`);
        await sleep(1500);
    }
    throw new Error(`receipt never confirmed for ${txHash}`);
}

// ---- Preflight
const chainId = await pub.getChainId();
if (chainId !== 31337) fail(`RPC chain ID is ${chainId}; this rehearsal runs only on Anvil 31337.`);
if (!(await pub.getCode({ address: TOKEN })))
    fail("No code at TEPA_TOKEN_ADDRESS. Deploy the local token after reset.");
if (!(await pub.getCode({ address: USDC })))
    fail("No code at TEST_USDC_ADDRESS. Deploy local TestUsdc after reset.");
try {
    await fetch(`${API}/health`);
} catch {
    fail(`API is not reachable at ${API}. Start npm run dev with .env.anvil exported.`);
}
if (await read(TOKEN, tokenAbi, "terminalSettlement"))
    fail(
        "This scene is already finalized after acquisition. Run the guarded npm run demo:reset and redeploy.",
    );
log(`Anvil 31337, token ${TOKEN}, test USDC ${USDC}, holders ${A.wallet} / ${B.wallet}`);

// A. Issuer reconciliation
if (phases.has("A")) {
    log("== A. Issuer reconciliation");
    let ov = await get("/api/v1/issuer", "ISSUER_PREPARER");
    check(
        "fixture v1 imported by reset",
        ov.activeImport?.fixtureVersion === 1,
        ov.activeImport?.inputSha256,
    );
    check("12 monthly periods", ov.review.periods.length === 12);
    check(
        "every source row has a hash and evidence ref",
        ov.sourceRows.every((r) => /^[0-9a-f]{64}$/.test(r.rowSha256) && r.evidenceRef),
    );
    const open = ov.cases.filter((c) => c.status === "OPEN");
    log(
        `  ${ov.cases.length} flagged cases, ${open.length} open:`,
        ov.cases.map((c) => `${c.kind}:${c.period}`).join(", "),
    );
    if (open.length) {
        const early = await post(
            "/api/v1/reconciliations/approve",
            {},
            "FINANCE_REVIEWER",
            "Premature approval attempt",
            { expectFail: true },
        );
        check(
            "approval refused while cases are open",
            early.data.code === "UNRESOLVED_CASES",
            `${early.status} ${early.data.code}`,
        );
        const asPreparer = await post(
            `/api/v1/reconciliations/${encodeURIComponent(open[0].caseKey)}/resolve`,
            { resolutionCode: "ACCEPT_PROCESSOR" },
            "ISSUER_PREPARER",
            "Wrong role",
            { expectFail: true },
        );
        check(
            "issuer preparer cannot resolve review cases",
            asPreparer.status === 403,
            String(asPreparer.status),
        );
    } else skip("approval refused while cases are open", "cases already resolved");
    for (const c of open)
        await post(
            `/api/v1/reconciliations/${encodeURIComponent(c.caseKey)}/resolve`,
            { resolutionCode: c.kind === "RELATED_PARTY" ? "ACKNOWLEDGE_RELATED_PARTY" : "ACCEPT_PROCESSOR" },
            "FINANCE_REVIEWER",
            `Reviewed ${c.kind} for ${c.period} against fictional source rows`,
        );
    if (ov.approval?.status !== "CURRENT")
        await post(
            "/api/v1/reconciliations/approve",
            {},
            "FINANCE_REVIEWER",
            "Approve reconciled fictional v1 preview",
        );
    ov = await get("/api/v1/issuer", "ISSUER_PREPARER");
    check("financial preview approved", ov.approval?.status === "CURRENT", ov.approval?.formulaVersion);
    log(
        `  annual defined distributable cash ${ov.review.annual.definedDistributableCashMinor} cents, pool ${ov.review.annual.distributionPoolMinor} cents`,
    );
    checkpoint("cash");
}

// B. Eligibility, wallet binding, issuance
if (phases.has("B")) {
    log("== B. Eligibility, wallet binding, issuance");
    let p2 = await get("/api/v1/phase2", "REGISTRY_AGENT");
    if (!p2.terms)
        await post("/api/v1/phase2/terms/publish", {}, "ISSUER_PREPARER", "Publish fictional terms v1");
    p2 = await get("/api/v1/phase2", "REGISTRY_AGENT");
    check(
        "terms v1 published with disclosures",
        p2.terms?.version === 1 && p2.terms.disclosures.length > 0,
        `${p2.terms.unitCount} units, ${p2.terms.participationBasisPoints} bps`,
    );
    // Simulated eligibility is capped at 30 days by the API; 29 days keeps a margin.
    const expires = new Date(Date.now() + 29 * 86400_000).toISOString();
    for (const [ref, h] of Object.entries(HOLDERS)) {
        const row = () =>
            get("/api/v1/phase2", "REGISTRY_AGENT").then((d) => d.holders.find((x) => x.holderRef === ref));
        let r = await row();
        if (r.recordedUnits > 0) {
            log(`  ${ref} already recorded`);
            continue;
        }
        if (r.termsVersionAcknowledged !== 1)
            await post(
                `/api/v1/phase2/holders/${ref}/acknowledge`,
                { termsSha256: p2.terms.sha256 },
                h.role,
                "Fictional holder acknowledges terms v1 and risks",
            );
        if (r.eligibilityStatus !== "APPROVED")
            await post(
                `/api/v1/phase2/holders/${ref}/eligibility`,
                { identity: "PASS", sanctions: "CLEAR", expiresAt: expires, jurisdiction: "US" },
                "COMPLIANCE_OPERATOR",
                "Record simulated identity and sanctions result",
            );
        r = await row();
        if (!r.walletAddress) {
            const wrong = await post(
                `/api/v1/phase2/holders/${ref}/challenge`,
                { walletAddress: "0x000000000000000000000000000000000000dEaD", chainId: 31337 },
                h.role,
                "Wrong wallet attempt",
                { expectFail: true },
            );
            check(
                `${ref}: unapproved wallet refused before challenge`,
                wrong.data.code === "UNEXPECTED_DEMO_WALLET",
                `${wrong.status} ${wrong.data.code}`,
            );
            const ch = await post(
                `/api/v1/phase2/holders/${ref}/challenge`,
                { walletAddress: h.wallet, chainId: 31337 },
                h.role,
                "Request wallet binding challenge",
            );
            const signature = await h.client.signMessage({ message: ch.message });
            await post(
                `/api/v1/phase2/holders/${ref}/bind`,
                { challengeId: ch.challengeId, signature },
                h.role,
                "Bind signed demo wallet",
            );
        }
        r = await row();
        if (r.subscriptionStatus === "ELIGIBLE")
            await post(`/api/v1/phase2/holders/${ref}/commit`, {}, h.role, "Record simulated subscription");
        r = await row();
        if (r.subscriptionStatus === "COMMITTED_SIMULATION")
            await post(
                `/api/v1/phase2/holders/${ref}/allocate`,
                {},
                "REGISTRY_AGENT",
                `Allocate ${r.plannedUnits} planned units`,
            );
        r = await row();
        if (r.subscriptionStatus === "ALLOCATED")
            await post(
                `/api/v1/phase2/holders/${ref}/issue`,
                {},
                "REGISTRY_AGENT",
                "Queue restricted issuance",
            );
    }
    const done = await until("issuance recorded by worker", async () => {
        const d = await get("/api/v1/phase2", "REGISTRY_AGENT");
        if (d.issuanceOperations.some((o) => o.status === "RECONCILIATION_REQUIRED"))
            throw new Error("issuance is RECONCILIATION_REQUIRED; inspect the operation");
        return d.holders.every((x) => x.recordedUnits === x.plannedUnits) ? d : null;
    });
    for (const x of done.holders) log(`  ${x.holderRef}: ${x.recordedUnits} units tx ${x.issuanceTxHash}`);
    if ((await supply()) === 1000n) {
        check(
            "chain balances 600/400 match register",
            (await bal(A.wallet)) === 600n && (await bal(B.wallet)) === 400n,
        );
        check("total supply 1000", true);
    } else skip("chain balances 600/400 match register", "settlement burns already recorded");
    checkpoint("issuance");
}

// C. Prohibited transfers: the token rejects ordinary holder-to-holder movement at contract level.
if (phases.has("C")) {
    log("== C. Prohibited transfers");
    const before = await bal(A.wallet);
    const t = await revertName(TOKEN, tokenAbi, "transfer", [B.wallet, 1n], A.wallet);
    check("transfer reverts", t === "RestrictedTransfer", t);
    const tf = await revertName(TOKEN, tokenAbi, "transferFrom", [A.wallet, B.wallet, 1n], B.wallet);
    check("transferFrom reverts", tf === "RestrictedTransfer", tf);
    const ap = await revertName(TOKEN, tokenAbi, "approve", [B.wallet, 1n], A.wallet);
    check("approve reverts", ap === "RestrictedTransfer", ap);
    // Broadcast a signed transfer with a fixed gas limit so it is mined, then confirm it reverted.
    const { receipt } = await send(A, TOKEN, tokenAbi, "transfer", [B.wallet, 1n], { gas: 100_000n });
    check(
        "signed, mined transfer reverts and balance is unchanged",
        receipt.status === "reverted" && (await bal(A.wallet)) === before,
        receipt.status,
    );
    const m = await revertName(
        TOKEN,
        tokenAbi,
        "mint",
        ["0x" + "11".repeat(32), B.wallet, 1, "0x" + "22".repeat(32)],
        A.wallet,
    );
    check("holder cannot mint", m === "Unauthorized", m);
}

// D. Quarterly distribution 2025-Q1
if (phases.has("D")) {
    log("== D. Quarterly distribution 2025-Q1");
    const list = () => get("/api/v1/distributions", "DISTRIBUTION_OPERATOR");
    let ep = (await list()).epochs.find((e) => e.quarter === "2025-Q1" && e.state !== "CANCELLED");
    if (!ep) {
        const op = await post(
            "/api/v1/distributions",
            { quarter: "2025-Q1" },
            "ISSUER_PREPARER",
            "Prepare fictional 2025-Q1 distribution",
        );
        ep = (await list()).epochs.find((e) => e.id === op.epochId);
    }
    const id = ep.id;
    const forbidden = await post(
        `/api/v1/distributions/${id}/approve`,
        {},
        "INVESTOR_A",
        "Holder tries to approve",
        { expectFail: true },
    );
    check("holder cannot approve a distribution", forbidden.status === 403, String(forbidden.status));
    const order = ["DRAFT", "RECONCILED", "REVIEWED", "APPROVED", "SNAPSHOTTED"];
    for (const [seg, role, target] of [
        ["reconcile", "ISSUER_PREPARER", "RECONCILED"],
        ["review", "FINANCE_REVIEWER", "REVIEWED"],
        ["approve", "FINANCE_REVIEWER", "APPROVED"],
        ["snapshot", "DISTRIBUTION_OPERATOR", "SNAPSHOTTED"],
    ]) {
        ep = (await list()).epochs.find((e) => e.id === id);
        const at = order.indexOf(ep.state);
        if (at === -1 || at >= order.indexOf(target)) continue;
        await post(
            `/api/v1/distributions/${id}/${seg}`,
            {},
            role,
            `Distribution ${seg} for fictional 2025-Q1`,
        );
    }
    ep = (await list()).epochs.find((e) => e.id === id);
    log(
        `  state=${ep.state} pool=${ep.poolUsdMinor} cents (${ep.poolTestUsdcMinor} test-USDC units) root=${ep.entitlementRoot}`,
    );
    const sum = ep.entitlements.reduce((s, e) => s + BigInt(e.amountUsdMinor), 0n);
    check(
        "entitlements sum to approved pool",
        sum === BigInt(ep.poolUsdMinor),
        ep.entitlements.map((e) => `${e.holderRef}:${e.amountUsdMinor}`).join(" "),
    );
    check("record block hash and snapshot hash frozen", !!ep.recordBlockHash && !!ep.snapshotHash);
    const watch = (label, field) =>
        until(label, async () => {
            const e = (await list()).epochs.find((x) => x.id === id);
            if (e.state === "RECONCILIATION_REQUIRED")
                throw new Error(
                    `distribution RECONCILIATION_REQUIRED: ${JSON.stringify(e.reconciliationIncidents)}`,
                );
            return e[field] ? e : null;
        });
    if (!ep.fundingTxHash)
        await post(
            `/api/v1/distributions/${id}/fund`,
            {},
            "DISTRIBUTION_OPERATOR",
            "Queue vault deploy and funding",
        );
    ep = await watch("distribution funded", "fundingTxHash");
    if (!ep.openingTxHash)
        await post(`/api/v1/distributions/${id}/open`, {}, "DISTRIBUTION_OPERATOR", "Queue claim opening");
    ep = await watch("claims open", "openingTxHash");
    log(`  vault ${ep.vaultAddress}; chain steps ${ep.chainSteps.map((s) => s.step).join(",")}`);
    const vault = getAddress(ep.vaultAddress);
    const entA = ep.entitlements.find((e) => e.holderRef === "synthetic-holder-a");
    if (!entA.claimTxHash) {
        const steal = await revertName(
            vault,
            vaultAbi,
            "claim",
            [BigInt(entA.index), BigInt(entA.amountTestUsdcMinor), entA.proof],
            B.wallet,
        );
        check("holder B cannot use holder A's proof", steal === "InvalidProof", steal);
    } else skip("holder B cannot use holder A's proof", "holder A already claimed");
    log(`  evidence page: http://localhost:5173/demo/evidence?epoch=${id}`);
    checkpoint("distribution-open");
    for (const ent of ep.entitlements) {
        const h = HOLDERS[ent.holderRef];
        const claimArgs = [BigInt(ent.index), BigInt(ent.amountTestUsdcMinor), ent.proof];
        if (!ent.claimTxHash) {
            const { hash } = await send(h, vault, vaultAbi, "claim", claimArgs);
            await recordReceipt(
                `/api/v1/distributions/${id}/claim-receipts`,
                hash,
                h.role,
                "Record confirmed fictional holder claim",
            );
        }
        const dup = await revertName(vault, vaultAbi, "claim", claimArgs, h.wallet);
        check(`${ent.holderRef}: duplicate claim reverts`, dup === "AlreadyClaimed", dup);
    }
    ep = (await list()).epochs.find((x) => x.id === id);
    check(
        "both claims recorded with block hash and log index",
        ep.entitlements.every((e) => e.claimTxHash && e.claimBlockHash && e.claimLogIndex !== null),
    );
    if ((await supply()) === 1000n)
        check(
            "mock test USDC balances 612/408",
            (await usdc(A.wallet)) === 612_000_000n && (await usdc(B.wallet)) === 408_000_000n,
        );
    else skip("mock test USDC balances 612/408", "settlement payouts already recorded");
    check("no distribution reconciliation incidents", ep.reconciliationIncidents.length === 0, ep.state);
}

// Settlement helpers shared by buyback and acquisition.
const settle = (role = "DISTRIBUTION_OPERATOR") => get("/api/v1/settlements", role);
async function payCase(kind, caseId, stopName) {
    const c = await until(`${kind} funded and open`, async () => {
        const x = (await settle()).cases.find((y) => y.id === caseId);
        if (/RECONCILIATION/.test(x.state)) throw new Error(`${kind} is RECONCILIATION_REQUIRED`);
        return x.opening_tx_hash ? x : null;
    });
    if (kind === "buybacks")
        check(
            "buyback price is binding once funded",
            c.priceStatus === "FUNDED_BINDING",
            `${c.state} ${c.priceStatus}`,
        );
    log(`  ${kind} vault ${c.vault_address} state ${c.state}`);
    if (stopName) checkpoint(stopName);
    const vault = getAddress(c.vault_address);
    for (const a of c.allocations) {
        if (a.accepted_units === 0) continue;
        const h = HOLDERS[a.holder_ref];
        const settleArgs = [
            BigInt(a.leaf_index),
            BigInt(a.accepted_units),
            BigInt(a.amount_test_usdc_minor),
            a.proof,
        ];
        if (!a.tx_hash) {
            const { hash } = await send(h, vault, vaultAbi, "settle", settleArgs);
            await recordReceipt(
                `/api/v1/${kind}/${caseId}/receipts`,
                hash,
                h.role,
                "Record confirmed settlement payment and burn",
            );
        }
        const dup = await revertName(vault, vaultAbi, "settle", settleArgs, h.wallet);
        check(`${kind} ${a.holder_ref}: duplicate settlement reverts`, dup !== null, dup);
    }
    const now = (await settle()).cases.find((y) => y.id === caseId);
    if (!now.finalization_tx_hash)
        await post(
            `/api/v1/${kind}/${caseId}/finalize`,
            {},
            "DISTRIBUTION_OPERATOR",
            `Finalize ${kind} after all outcomes recorded`,
        );
    return until(`${kind} finalized`, async () => {
        const x = (await settle()).cases.find((y) => y.id === caseId);
        if (/RECONCILIATION/.test(x.state))
            throw new Error(`${kind} finalization is RECONCILIATION_REQUIRED`);
        return x.finalization_tx_hash ? x : null;
    });
}

// E. Appraisal and buyback
if (phases.has("E")) {
    log("== E. Appraisal and buyback");
    let ap = (await settle()).appraisals.find((a) => a.state !== "CANCELLED");
    if (!ap) {
        const op = await post(
            "/api/v1/appraisals",
            fixture.appraisal,
            "ISSUER_PREPARER",
            "Record fictional sample appraisal",
        );
        ap = (await settle()).appraisals.find((a) => a.id === op.appraisalId);
    }
    check(
        "informational unit estimate $200",
        ap.indicative_unit_usd_minor === fixture.expectedIndicativeUnitUsdMinor,
        String(ap.indicative_unit_usd_minor),
    );
    if (!ap.approved_by) {
        const self = await post(
            `/api/v1/appraisals/${ap.id}/approve`,
            {},
            "ISSUER_PREPARER",
            "Preparer self-approval attempt",
            { expectFail: true },
        );
        check("preparer cannot approve own appraisal", self.status === 403, String(self.status));
        await post(
            `/api/v1/appraisals/${ap.id}/approve`,
            {},
            "FINANCE_REVIEWER",
            "Approve fictional appraisal",
        );
    }
    let bb = (await settle()).cases.find((c) => c.kind === "BUYBACK" && !/CANCELLED|EXPIRED/.test(c.state));
    if (!bb) {
        const deadline = new Date(Date.now() + tenderSeconds * 1000).toISOString();
        const op = await post(
            "/api/v1/buybacks",
            {
                appraisalId: ap.id,
                budgetUsdMinor: fixture.buyback.budgetUsdMinor,
                bindingUnitPriceUsdMinor: fixture.buyback.bindingUnitPriceUsdMinor,
                tenderDeadline: deadline,
            },
            "ISSUER_PREPARER",
            "Prepare budgeted buyback window",
        );
        await post(
            `/api/v1/buybacks/${op.caseId}/approve`,
            {},
            "FINANCE_REVIEWER",
            "Approve buyback budget and price",
        );
        await post(`/api/v1/buybacks/${op.caseId}/open`, {}, "ISSUER_PREPARER", "Open buyback window");
        bb = (await settle()).cases.find((c) => c.id === op.caseId);
    }
    log(`  buyback ${bb.id} state=${bb.state} priceStatus=${bb.priceStatus} deadline=${bb.tender_deadline}`);
    checkpoint("buyback-open");
    if (bb.state === "OPEN") {
        if (new Date(bb.tender_deadline).getTime() > Date.now() + 5000) {
            const over = await post(
                `/api/v1/buybacks/${bb.id}/tenders`,
                { units: 401 },
                "INVESTOR_B",
                "Tender above holdings",
                { expectFail: true },
            );
            check(
                "tender above holdings refused",
                over.data.code === "TENDER_EXCEEDS_HOLDING",
                `${over.status} ${over.data.code}`,
            );
        } else skip("tender above holdings refused", "tender deadline already passed");
        const active = (t) => !t.cancelled_at;
        const tenders = bb.tenders.filter(active);
        if (!tenders.some((t) => t.holder_ref === "synthetic-holder-a")) {
            await post(
                `/api/v1/buybacks/${bb.id}/tenders`,
                { units: 50 },
                "INVESTOR_A",
                "Tender then cancel",
            );
            const cur = (await settle("INVESTOR_A")).cases.find((c) => c.id === bb.id).tenders.find(active);
            await post(
                `/api/v1/buybacks/${bb.id}/tenders/${cur.id}/cancel`,
                {},
                "INVESTOR_A",
                "Cancel tender before deadline",
            );
            await post(`/api/v1/buybacks/${bb.id}/tenders`, { units: 200 }, "INVESTOR_A", "Tender 200 units");
        }
        if (!tenders.some((t) => t.holder_ref === "synthetic-holder-b"))
            await post(`/api/v1/buybacks/${bb.id}/tenders`, { units: 200 }, "INVESTOR_B", "Tender 200 units");
        const wait = new Date(bb.tender_deadline).getTime() - Date.now() + 2000;
        if (wait > 2000) {
            const early = await post(
                `/api/v1/buybacks/${bb.id}/close-tenders`,
                {},
                "DISTRIBUTION_OPERATOR",
                "Close before deadline",
                { expectFail: true },
            );
            check(
                "cannot close tenders before deadline",
                early.data.code === "DEADLINE_NOT_REACHED",
                `${early.status} ${early.data.code}`,
            );
        }
        if (wait > 0) {
            log(`  waiting ${Math.round(wait / 1000)}s for the tender deadline`);
            await sleep(wait);
        }
        await mine(1);
        await post(
            `/api/v1/buybacks/${bb.id}/close-tenders`,
            {},
            "DISTRIBUTION_OPERATOR",
            "Close tenders after deadline",
        );
    }
    bb = (await settle()).cases.find((c) => c.id === bb.id);
    if (!bb.entitlement_root)
        await post(
            `/api/v1/buybacks/${bb.id}/allocate`,
            {},
            "DISTRIBUTION_OPERATOR",
            "Allocate oversubscribed tenders",
        );
    bb = (await settle()).cases.find((c) => c.id === bb.id);
    log(
        `  allocation: ${bb.allocations.map((a) => `${a.holder_ref} accepted ${a.accepted_units} for ${a.amount_usd_minor}c`).join("; ")}`,
    );
    check(
        "oversubscription accepts 125 + 125 units",
        bb.allocations.every((a) => a.accepted_units === 125) && bb.committed_units === 250,
        `committed ${bb.committed_units} units ${bb.committed_usd_minor}c`,
    );
    if (!bb.funding_tx_hash) {
        check(
            "price is funding-pending before funding",
            bb.priceStatus === "FUNDING_PENDING",
            bb.priceStatus,
        );
        await post(
            `/api/v1/buybacks/${bb.id}/fund`,
            {},
            "DISTRIBUTION_OPERATOR",
            "Queue buyback vault funding",
        );
    }
    bb = await payCase("buybacks", bb.id);
    log(`  buyback final state ${bb.state}`);
    check(
        "250 paid units burned, 750 remain (475/275)",
        (await supply()) === 750n && (await bal(A.wallet)) === 475n && (await bal(B.wallet)) === 275n,
    );
    check(
        "buyback paid 25,000 test USDC to each holder",
        (await usdc(A.wallet)) === 25_612_000_000n && (await usdc(B.wallet)) === 25_408_000_000n,
    );
}

// F. Acquisition
if (phases.has("F")) {
    log("== F. Acquisition");
    const { expectedSettlementPoolUsdMinor, ...waterfall } = fixture.acquisition;
    let aq = (await settle()).cases.find((c) => c.kind === "ACQUISITION" && !/CANCELLED/.test(c.state));
    if (!aq) {
        const op = await post(
            "/api/v1/acquisitions",
            waterfall,
            "ISSUER_PREPARER",
            "Enter disclosed fictional acquisition waterfall",
        );
        await post(
            `/api/v1/acquisitions/${op.caseId}/review`,
            {},
            "FINANCE_REVIEWER",
            "Review acquisition evidence",
        );
        await post(
            `/api/v1/acquisitions/${op.caseId}/approve`,
            {},
            "FINANCE_REVIEWER",
            "Approve acquisition waterfall",
        );
        await post(
            `/api/v1/acquisitions/${op.caseId}/snapshot`,
            {},
            "DISTRIBUTION_OPERATOR",
            "Snapshot remaining eligible units",
        );
        aq = (await settle()).cases.find((c) => c.id === op.caseId);
    }
    log(
        `  allocation: ${aq.allocations.map((a) => `${a.holder_ref} ${a.accepted_units} units -> ${a.amount_usd_minor}c`).join("; ")}`,
    );
    check(
        "acquisition pool $80,000 over 750 remaining units",
        aq.committed_usd_minor === expectedSettlementPoolUsdMinor && aq.committed_units === 750,
        `${aq.committed_usd_minor}c ${aq.committed_units}u`,
    );
    if (!aq.funding_tx_hash)
        await post(
            `/api/v1/acquisitions/${aq.id}/fund`,
            {},
            "DISTRIBUTION_OPERATOR",
            "Queue acquisition funding",
        );
    aq = await payCase("acquisitions", aq.id, "acquisition-ready");
    log(`  acquisition final state ${aq.state}`);
    check("acquisition finalized", aq.state === "FINALIZED", aq.state);
    check("token supply is zero", (await supply()) === 0n);
    check("token terminal marker set", await read(TOKEN, tokenAbi, "terminalSettlement"));
    const q2 = await post(
        "/api/v1/distributions",
        { quarter: "2025-Q2" },
        "ISSUER_PREPARER",
        "Attempt distribution after acquisition",
        { expectFail: true },
    );
    check(
        "new distribution refused after acquisition",
        q2.data.code === "TERMINAL_SETTLEMENT",
        `${q2.status} ${q2.data.code}`,
    );
    const m = await revertName(
        TOKEN,
        tokenAbi,
        "mint",
        ["0x" + "11".repeat(32), A.wallet, 1, "0x" + "22".repeat(32)],
        getAddress(env.ISSUER_SIGNER_ADDRESS),
    );
    check("token refuses new minting by the issuer agent", m === "TerminalSettlement", m);
}

// G. Audit trail and role boundaries
if (phases.has("G")) {
    log("== G. Audit explorer");
    const ev = (await get("/api/v1/audit-events", "AUDITOR")).events;
    const byType = {};
    for (const e of ev) byType[e.resourceType] = (byType[e.resourceType] ?? 0) + 1;
    log(`  ${ev.length} events:`, JSON.stringify(byType));
    check(
        "audit events carry formula and policy or terms versions",
        ev.some((e) => e.formulaVersion) && ev.some((e) => e.policyVersion || e.termsVersion),
    );
    let denied = 0;
    try {
        await get("/api/v1/audit-events", "INVESTOR_A");
    } catch (e) {
        denied = e.status;
    }
    check("holder cannot open the audit explorer", denied === 403, String(denied));
    // CX-1: chain-backed events must reference their chain command and event.
    const linked = ev.filter((e) => e.chainCommandId && e.chainEventId);
    const linkedTypes = new Set(linked.map((e) => e.resourceType));
    const expected = ["phase2", "distribution", "settlement"].filter((t) => byType[t]);
    const ok = expected.every((t) => linkedTypes.has(t));
    const detail = `${linked.length} linked events; types ${[...linkedTypes].join(",") || "none"}`;
    if (strictAudit) check("chain-backed audit events reference chain command and event", ok, detail);
    else {
        results.push({ name: "audit chain references", ok: true, skipped: true });
        log(
            ok ? "PASS" : "GAP ",
            "chain-backed audit events reference chain command and event",
            `${detail} (run with --strict-audit to enforce; CX-1)`,
        );
    }
}

summary();
