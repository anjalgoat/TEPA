import { useEffect, useRef, useState } from "react";
import { encodeFunctionData, parseAbi } from "viem";
import { fetchDistributions, mutateDistribution, type DemoRole, type Distributions } from "./api.js";
import { chainName } from "./DemoJourney.js";
import { walletErrorMessage } from "./walletFeedback.js";

const claimAbi = parseAbi(["function claim(uint256,uint256,bytes32[])"]);
const actionReason = "Record this fictional quarterly distribution step";
const dollar = (minor: string) => {
    const amount = BigInt(minor);
    return `$${(amount / 100n).toLocaleString("en-US")}.${(amount % 100n).toString().padStart(2, "0")}`;
};
const usdc = (minor: string) => {
    const amount = BigInt(minor);
    return `${(amount / 1_000_000n).toLocaleString("en-US")}.${(amount % 1_000_000n).toString().padStart(6, "0")} test USDC`;
};
const chainLink = (chainId: number, tx: string) =>
    chainId === 84532 ? `https://sepolia.basescan.org/tx/${tx}` : null;
type Epoch = Distributions["epochs"][number];

function Evidence({ epoch, chainId }: { epoch: Epoch; chainId: number }) {
    return (
        <div className="distribution-evidence">
            <div>
                <h3>Approved cash source</h3>
                <p>
                    Defined cash {dollar(epoch.cashSnapshot.definedCashMinor)} at{" "}
                    {epoch.cashSnapshot.participationBasisPoints / 100}% sample participation. Pool{" "}
                    {dollar(epoch.poolUsdMinor)}.
                </p>
                <p>
                    Financial approval {epoch.cashSnapshot.financialApprovalId}. Prepared by{" "}
                    {epoch.preparedBy}; reviewed by {epoch.reviewedBy ?? "pending"}; approved by{" "}
                    {epoch.approvedBy ?? "pending"}.
                </p>
                <p>
                    Formula {epoch.formulaVersion}. Cash snapshot SHA-256{" "}
                    <code>{epoch.cashSnapshotSha256}</code>
                </p>
                <details>
                    <summary>Inspect monthly inputs and evidence</summary>
                    <ol>
                        {epoch.cashSnapshot.periods.map((period) => (
                            <li key={period.period}>
                                <strong>{period.period}</strong>: defined cash{" "}
                                {dollar(period.definedDistributableCashMinor)}.
                                {Object.values(period.lines)
                                    .flatMap((line) => line.sourceRefs)
                                    .map((ref) => {
                                        const source = epoch.cashSnapshot.sourceRows.find(
                                            (row) => row.sourceRef === ref,
                                        );
                                        return (
                                            <span className="distribution-source" key={ref}>
                                                {ref} · {source?.evidenceRef ?? "Source missing"} · SHA-256{" "}
                                                {source?.rowSha256 ?? "missing"}
                                            </span>
                                        );
                                    })}
                            </li>
                        ))}
                    </ol>
                </details>
            </div>
            <div>
                <h3>Record date and commitment</h3>
                <p>{epoch.recordBlock ? `Block ${epoch.recordBlock}` : "Balance snapshot pending"}</p>
                {epoch.recordBlockHash && (
                    <p>
                        Block hash <code>{epoch.recordBlockHash}</code>
                    </p>
                )}
                {epoch.entitlementRoot && (
                    <p>
                        Immutable entitlement root <code>{epoch.entitlementRoot}</code>
                    </p>
                )}
                {epoch.vaultAddress && (
                    <p>
                        Vault <code>{epoch.vaultAddress}</code>
                    </p>
                )}
                {epoch.fundingTxHash && (
                    <p>
                        Funded transaction{" "}
                        {chainLink(chainId, epoch.fundingTxHash) ? (
                            <a
                                href={chainLink(chainId, epoch.fundingTxHash)!}
                                target="_blank"
                                rel="noreferrer"
                            >
                                View on BaseScan
                            </a>
                        ) : (
                            <code>{epoch.fundingTxHash}</code>
                        )}
                    </p>
                )}
                <p>
                    Claims open only after the vault holds the full {usdc(epoch.poolTestUsdcMinor)}{" "}
                    commitment.
                </p>
            </div>
        </div>
    );
}

export function DistributionPanel({
    token,
    role,
    issuerVersion,
    onChange,
    currentRun,
    sessionForRole,
}: {
    token: string | null;
    role: DemoRole;
    issuerVersion: number | null;
    onChange: () => Promise<void>;
    currentRun: Distributions | null;
    sessionForRole?: (role: DemoRole) => Promise<string>;
}) {
    const [data, setData] = useState<Distributions | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [pending, setPending] = useState<string | null>(null);
    const [quarter, setQuarter] = useState("2025-Q1");
    const [cancelReason, setCancelReason] = useState("");
    const version = useRef(0);
    const keys = useRef(new Map<string, string>());
    // Epoch states when a chain action was queued; polling stops once the worker moves them on.
    const [awaitingFrom, setAwaitingFrom] = useState<string | null>(null);
    const epochStates = (value: Distributions | null) =>
        value?.epochs.map((epoch) => `${epoch.id}:${epoch.state}`).join(",") ?? "";
    useEffect(() => {
        if (!token) {
            setData(null);
            setLoading(false);
            return;
        }
        let active = true;
        setLoading(true);
        setData(null);
        setError(null);
        setNotice(null);
        fetchDistributions(token)
            .then((result) => {
                if (active) {
                    version.current = result.issuerVersion;
                    setData(result);
                }
            })
            .catch((cause) => {
                if (active)
                    setError(
                        cause instanceof Error ? cause.message : "Distribution records are unavailable.",
                    );
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, [token, role, issuerVersion]);
    useEffect(() => {
        if (currentRun) {
            version.current = currentRun.issuerVersion;
            setData(currentRun);
        }
    }, [currentRun]);
    async function refresh() {
        if (!token) return null;
        const result = await fetchDistributions(token);
        version.current = result.issuerVersion;
        setData(result);
        await onChange();
        return result;
    }
    useEffect(() => {
        if (awaitingFrom === null) return;
        if (epochStates(data) !== awaitingFrom) {
            setAwaitingFrom(null);
            setNotice("The worker confirmed the chain action.");
            return;
        }
        const timer = window.setTimeout(() => void refresh().catch(() => undefined), 3000);
        return () => window.clearTimeout(timer);
    }, [awaitingFrom, data]);
    async function act(label: string, path: string, body: unknown, reason = actionReason) {
        if (!token || !data) return;
        const keyName = `${label}:${version.current}`;
        const idempotencyKey = keys.current.get(keyName) ?? crypto.randomUUID();
        keys.current.set(keyName, idempotencyKey);
        setPending(label);
        setError(null);
        setNotice(null);
        try {
            const actionRole: DemoRole =
                path === "/" || path.endsWith("/reconcile") || path.endsWith("/cancel")
                    ? "ISSUER_PREPARER"
                    : path.endsWith("/review") || path.endsWith("/approve")
                      ? "FINANCE_REVIEWER"
                      : "DISTRIBUTION_OPERATOR";
            const actionToken = sessionForRole ? await sessionForRole(actionRole) : token;
            const result = await mutateDistribution(
                actionToken,
                path,
                body,
                version.current,
                reason,
                idempotencyKey,
            );
            keys.current.delete(keyName);
            version.current = result.resourceVersion;
            const latest = await refresh();
            if (result.status === "PENDING") {
                setNotice(
                    "Chain action queued. The distribution worker must confirm it before this state advances.",
                );
                setAwaitingFrom(epochStates(latest));
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "The distribution action failed.");
        } finally {
            setPending(null);
        }
    }
    async function claim(epoch: Epoch, entitlement: Epoch["entitlements"][number]) {
        if (!token || !data) return;
        if (!entitlement || !epoch.vaultAddress) return;
        setPending("claim");
        setError(null);
        setNotice(null);
        try {
            const storageKey = `tepa-pending-claim:${epoch.id}:${entitlement.holderRef}`;
            let txHash = localStorage.getItem(storageKey);
            if (!txHash) {
                if (!window.ethereum) throw new Error("Connect an Ethereum wallet to claim test USDC.");
                const chainHex = await window.ethereum.request({ method: "eth_chainId" });
                if (Number.parseInt(String(chainHex), 16) !== data.chainId)
                    throw new Error(
                        `Switch your wallet to ${chainName(data.chainId)} (chain ${data.chainId}) and try again.`,
                    );
                const accounts = (await window.ethereum.request({
                    method: "eth_requestAccounts",
                })) as string[];
                const account = accounts[0];
                if (!account || account.toLowerCase() !== entitlement.walletAddress.toLowerCase())
                    throw new Error("Select the wallet bound to this fictional holder.");
                txHash = (await window.ethereum.request({
                    method: "eth_sendTransaction",
                    params: [
                        {
                            from: account,
                            to: epoch.vaultAddress,
                            data: encodeFunctionData({
                                abi: claimAbi,
                                functionName: "claim",
                                args: [
                                    BigInt(entitlement.index),
                                    BigInt(entitlement.amountTestUsdcMinor),
                                    entitlement.proof as `0x${string}`[],
                                ],
                            }),
                        },
                    ],
                })) as string;
            }
            if (!/^0x[0-9a-fA-F]{64}$/.test(txHash))
                throw new Error("Wallet did not return a claim transaction hash.");
            localStorage.setItem(storageKey, txHash);
            setNotice(`Claim submitted: ${txHash}. Waiting for chain confirmation.`);
            const claimToken = sessionForRole
                ? await sessionForRole(
                      entitlement.holderRef === "synthetic-holder-b" ? "INVESTOR_B" : "INVESTOR_A",
                  )
                : token;
            for (let attempt = 0; attempt < 15; attempt++) {
                try {
                    await mutateDistribution(
                        claimToken,
                        `/${epoch.id}/claim-receipts`,
                        { txHash },
                        version.current,
                        "Record confirmed fictional holder claim",
                        crypto.randomUUID(),
                    );
                    localStorage.removeItem(storageKey);
                    await refresh();
                    setNotice("The test USDC claim was confirmed and matched to this entitlement.");
                    return;
                } catch (cause) {
                    const message = cause instanceof Error ? cause.message : "Claim confirmation is pending.";
                    if (!/not confirmed|three chain confirmations/i.test(message)) throw cause;
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }
            }
            setNotice(
                "The claim is still awaiting confirmations. Use Record existing claim later; the transaction hash has been kept in this browser.",
            );
        } catch (cause) {
            await refresh().catch(() => undefined);
            setError(walletErrorMessage(cause, "Claim could not be confirmed."));
        } finally {
            setPending(null);
        }
    }
    const investor = role === "INVESTOR_A" || role === "INVESTOR_B";
    return (
        <section className="distribution" aria-labelledby="distribution-heading">
            <div className="section-heading">
                <div>
                    <p className="section-index">05 / Quarterly distribution</p>
                    <h2 id="distribution-heading">From reviewed cash to one claim</h2>
                </div>
                <p>Sample quarter · fixed record date · test USDC</p>
            </div>
            <p className="prototype-notice distribution-notice" role="note">
                Prototype only. Fictional issuer and investors. No real securities are offered, no real money
                is accepted, and testnet tokens have no financial value.
            </p>
            <p>
                Distributions depend on defined cash and may be zero. The unit does not promise a return,
                liquidity, or a withdrawal right.
            </p>
            {loading && <p role="status">Loading distribution epochs…</p>}
            {error && (
                <p className="phase2-error" role="alert">
                    {error}
                </p>
            )}
            {notice && (
                <p className="phase2-notice" role="status">
                    {notice}
                </p>
            )}
            {!loading && !data && (
                <p role="status">Distribution records are unavailable. Reload after the API is ready.</p>
            )}
            {data && data.epochs.length === 0 && (
                <div className="phase2-empty">
                    <h3>No quarterly epoch prepared</h3>
                    <p>
                        The issuer begins with a reviewed synthetic financial import and published prototype
                        terms.
                    </p>
                </div>
            )}
            {data && (sessionForRole || role === "ISSUER_PREPARER") && (
                <div className="distribution-prepare">
                    <label htmlFor="quarter-select">Synthetic quarter</label>
                    <select
                        id="quarter-select"
                        value={quarter}
                        onChange={(event) => setQuarter(event.target.value)}
                    >
                        {[1, 2, 3, 4].map((number) => (
                            <option key={number} value={`2025-Q${number}`}>
                                2025 Q{number}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        disabled={
                            pending !== null ||
                            data.epochs.some(
                                (epoch) => epoch.quarter === quarter && epoch.state !== "CANCELLED",
                            )
                        }
                        onClick={() => void act(`prepare:${quarter}`, "/", { quarter })}
                    >
                        Prepare selected quarter
                    </button>
                </div>
            )}
            {data?.epochs.map((epoch) => (
                <article className="distribution-epoch" key={epoch.id}>
                    <div className="distribution-summary">
                        <div>
                            <p className="section-index">
                                {epoch.quarter} · revision {epoch.revision} ·{" "}
                                {epoch.state.replaceAll("_", " ").toLowerCase()}
                            </p>
                            <h3>{dollar(epoch.poolUsdMinor)} sample holder pool</h3>
                            <p>Equivalent commitment: {usdc(epoch.poolTestUsdcMinor)}</p>
                            <a
                                href={`/demo/evidence?epoch=${encodeURIComponent(epoch.id)}${role === "INVESTOR_A" ? "&holder=synthetic-holder-a" : role === "INVESTOR_B" ? "&holder=synthetic-holder-b" : ""}`}
                            >
                                View calculation and transaction evidence
                            </a>
                        </div>
                        <div className="distribution-actions">
                            {(sessionForRole || role === "ISSUER_PREPARER") && epoch.state === "DRAFT" && (
                                <button
                                    type="button"
                                    disabled={pending !== null}
                                    onClick={() =>
                                        void act(`reconcile:${epoch.id}`, `/${epoch.id}/reconcile`, {})
                                    }
                                >
                                    Reconcile quarter
                                </button>
                            )}
                            {(sessionForRole || role === "FINANCE_REVIEWER") &&
                                epoch.state === "RECONCILED" && (
                                    <button
                                        type="button"
                                        disabled={pending !== null}
                                        onClick={() =>
                                            void act(`review:${epoch.id}`, `/${epoch.id}/review`, {})
                                        }
                                    >
                                        Record independent review
                                    </button>
                                )}
                            {(sessionForRole || role === "FINANCE_REVIEWER") &&
                                epoch.state === "REVIEWED" && (
                                    <button
                                        type="button"
                                        disabled={pending !== null}
                                        onClick={() =>
                                            void act(`approve:${epoch.id}`, `/${epoch.id}/approve`, {})
                                        }
                                    >
                                        Approve quarterly pool
                                    </button>
                                )}
                            {(sessionForRole || role === "DISTRIBUTION_OPERATOR") &&
                                epoch.state === "APPROVED" && (
                                    <button
                                        type="button"
                                        disabled={pending !== null}
                                        onClick={() =>
                                            void act(`snapshot:${epoch.id}`, `/${epoch.id}/snapshot`, {})
                                        }
                                    >
                                        Freeze record-date balances
                                    </button>
                                )}
                            {(sessionForRole || role === "DISTRIBUTION_OPERATOR") &&
                                epoch.state === "SNAPSHOTTED" && (
                                    <button
                                        type="button"
                                        disabled={pending !== null}
                                        onClick={() => void act(`fund:${epoch.id}`, `/${epoch.id}/fund`, {})}
                                    >
                                        Queue full vault funding
                                    </button>
                                )}
                            {(sessionForRole || role === "DISTRIBUTION_OPERATOR") &&
                                epoch.state === "FUNDED" && (
                                    <button
                                        type="button"
                                        disabled={pending !== null}
                                        onClick={() => void act(`open:${epoch.id}`, `/${epoch.id}/open`, {})}
                                    >
                                        Queue claim opening
                                    </button>
                                )}
                        </div>
                    </div>
                    {(sessionForRole || role === "ISSUER_PREPARER") &&
                        ["DRAFT", "RECONCILED", "REVIEWED", "APPROVED"].includes(epoch.state) && (
                            <div className="distribution-cancel">
                                <label htmlFor={`cancel-reason-${epoch.id}`}>
                                    Reason to cancel this pre-snapshot revision
                                </label>
                                <textarea
                                    id={`cancel-reason-${epoch.id}`}
                                    rows={2}
                                    value={cancelReason}
                                    onChange={(event) => setCancelReason(event.target.value)}
                                    placeholder="Explain the revised financial input or other cancellation reason"
                                />
                                <button
                                    type="button"
                                    disabled={pending !== null || cancelReason.trim().length < 8}
                                    onClick={() =>
                                        void act(
                                            `cancel:${epoch.id}`,
                                            `/${epoch.id}/cancel`,
                                            {},
                                            cancelReason.trim(),
                                        )
                                    }
                                >
                                    Cancel this revision
                                </button>
                            </div>
                        )}
                    {epoch.state === "RECONCILIATION_REQUIRED" && (
                        <div className="phase2-error" role="alert">
                            <p>
                                A chain or database write needs reconciliation. Do not treat this epoch as
                                funded or payable.
                            </p>
                            {epoch.reconciliationIncidents.map((incident, index) => (
                                <p key={`${incident.code}:${index}`}>
                                    {incident.code} · {incident.createdAt}
                                </p>
                            ))}
                        </div>
                    )}
                    <Evidence epoch={epoch} chainId={data.chainId} />
                    {epoch.entitlements.length > 0 && (
                        <div className="distribution-entitlements">
                            <h3>Frozen holder entitlements</h3>
                            <ul>
                                {epoch.entitlements.map((entitlement) => (
                                    <li key={entitlement.index}>
                                        <strong>
                                            {entitlement.holderRef
                                                .replace("synthetic-holder-", "Fictional holder ")
                                                .toUpperCase()}
                                        </strong>
                                        <span>
                                            {entitlement.eligibleUnits} record-date units ·{" "}
                                            {dollar(entitlement.amountUsdMinor)} ·{" "}
                                            {usdc(entitlement.amountTestUsdcMinor)}
                                        </span>
                                        <span>
                                            Remainder {entitlement.remainder};{" "}
                                            {entitlement.roundingUnitAwarded
                                                ? "one minor unit allocated by tie-break"
                                                : "no residual unit"}
                                            .
                                        </span>
                                        <span>
                                            Wallet <code>{entitlement.walletAddress}</code>
                                        </span>
                                        {entitlement.claimTxHash ? (
                                            <span>
                                                Already claimed; a second claim is unavailable. Recorded
                                                transaction:{" "}
                                                {chainLink(data.chainId, entitlement.claimTxHash) ? (
                                                    <a
                                                        href={chainLink(
                                                            data.chainId,
                                                            entitlement.claimTxHash,
                                                        )!}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                    >
                                                        View on BaseScan
                                                    </a>
                                                ) : (
                                                    <code>{entitlement.claimTxHash}</code>
                                                )}
                                                {entitlement.claimBlockNumber &&
                                                entitlement.claimLogIndex !== null
                                                    ? ` · block ${entitlement.claimBlockNumber}, event ${entitlement.claimLogIndex}`
                                                    : ""}
                                            </span>
                                        ) : BigInt(entitlement.amountTestUsdcMinor) === 0n ? (
                                            <span>Zero entitlement; no claim is due for this quarter.</span>
                                        ) : (
                                            (investor || sessionForRole) &&
                                            epoch.state === "CLAIMABLE" && (
                                                <button
                                                    type="button"
                                                    disabled={pending !== null}
                                                    onClick={() => void claim(epoch, entitlement)}
                                                >
                                                    {localStorage.getItem(
                                                        `tepa-pending-claim:${epoch.id}:${entitlement.holderRef}`,
                                                    )
                                                        ? "Record existing claim"
                                                        : `Claim this test USDC entitlement (${entitlement.holderRef === "synthetic-holder-b" ? "holder B" : "holder A"})`}
                                                </button>
                                            )
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </article>
            ))}
        </section>
    );
}
