import type { Distributions, Overview, Phase2 } from "./api.js";
import { chainName } from "./DemoJourney.js";
import historicalIssuance from "../../../smart-contract/deployments/base-sepolia.json";

type Epoch = Distributions["epochs"][number];
type Entitlement = Epoch["entitlements"][number];

function usd(minor: string): string {
    const amount = BigInt(minor);
    const absolute = amount < 0n ? -amount : amount;
    return `${amount < 0n ? "−" : ""}$${(absolute / 100n).toLocaleString("en-US")}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function testUsdc(minor: string): string {
    const amount = BigInt(minor);
    return `${(amount / 1_000_000n).toLocaleString("en-US")}.${(amount % 1_000_000n).toString().padStart(6, "0")} mock test USDC`;
}

function Transaction({ chainId, hash }: { chainId: number; hash: string }) {
    return chainId === 84532 ? (
        <a href={`https://sepolia.basescan.org/tx/${hash}`} target="_blank" rel="noreferrer">
            {hash}
        </a>
    ) : (
        <code>{hash}</code>
    );
}

function stageStatus(epoch: Epoch): string {
    if (epoch.state === "RECONCILIATION_REQUIRED")
        return "Reconciliation required. Chain and database evidence must be reviewed before this run is treated as payable.";
    if (epoch.state === "CANCELLED") return "This revision was cancelled before the record-date snapshot.";
    if (!epoch.approvedAt) return "Pool calculated from synthetic inputs; finance approval is pending.";
    if (!epoch.recordBlock) return "Pool approved; record-date balances have not been frozen.";
    if (!epoch.fundingTxHash || epoch.state === "SNAPSHOTTED")
        return "Snapshot frozen. The mock test-USDC vault is not yet confirmed funded.";
    if (!epoch.openingTxHash || epoch.state === "FUNDED")
        return "Vault funding recorded. Claim opening is pending.";
    return epoch.state === "CLOSED"
        ? "This distribution run is closed."
        : "Claims are open for this funded run.";
}

function EntitlementRecord({
    epoch,
    entitlement,
    chainId,
}: {
    epoch: Epoch;
    entitlement: Entitlement;
    chainId: number;
}) {
    const pendingHash =
        typeof window === "undefined"
            ? null
            : window.localStorage.getItem(`tepa-pending-claim:${epoch.id}:${entitlement.holderRef}`);
    return (
        <article className="evidence-holder">
            <h3>{entitlement.holderRef.replace("synthetic-holder-", "Fictional holder ").toUpperCase()}</h3>
            <dl className="evidence-facts">
                <div>
                    <dt>Record-date units</dt>
                    <dd>
                        {entitlement.eligibleUnits} of {epoch.eligibleSupply} eligible units
                    </dd>
                </div>
                <div>
                    <dt>Allocation</dt>
                    <dd>
                        {usd(entitlement.amountUsdMinor)} · {testUsdc(entitlement.amountTestUsdcMinor)}
                    </dd>
                </div>
                <div>
                    <dt>Method</dt>
                    <dd>
                        Approved pool × eligible units ÷ eligible supply; floor, then largest remainder.
                        Remainder {entitlement.remainder}
                        {entitlement.roundingUnitAwarded
                            ? "; one minor unit awarded by tie-break"
                            : "; no tie-break unit"}
                        .
                    </dd>
                </div>
                <div>
                    <dt>Bound wallet</dt>
                    <dd>
                        <code>{entitlement.walletAddress}</code>
                    </dd>
                </div>
                <div>
                    <dt>Claim status</dt>
                    <dd>
                        {entitlement.claimTxHash
                            ? epoch.state === "RECONCILIATION_REQUIRED"
                                ? "Claim receipt recorded; this run now requires reconciliation."
                                : "Already claimed and recorded. A second claim is unavailable."
                            : pendingHash
                              ? "Submitted in this browser; receipt not yet recorded. Check the saved transaction before retrying."
                              : epoch.state === "RECONCILIATION_REQUIRED"
                                ? "Blocked pending reconciliation."
                                : BigInt(entitlement.amountTestUsdcMinor) === 0n
                                  ? "Zero allocation; no claim is due."
                                  : epoch.state === "CLAIMABLE"
                                    ? "Funded and open; claim not yet recorded."
                                    : "Not claimable until the vault is funded and claims are open."}
                    </dd>
                </div>
            </dl>
            {pendingHash && !entitlement.claimTxHash && (
                <p>
                    Browser-stored, unverified submission:{" "}
                    <Transaction chainId={chainId} hash={pendingHash} />
                </p>
            )}
            {entitlement.claimTxHash && (
                <div className="evidence-receipt">
                    <p>
                        Recorded claim transaction:{" "}
                        <Transaction chainId={chainId} hash={entitlement.claimTxHash} />
                    </p>
                    <p>
                        Block {entitlement.claimBlockNumber ?? "unavailable"} · block hash{" "}
                        <code>{entitlement.claimBlockHash ?? "unavailable"}</code> · event index{" "}
                        {entitlement.claimLogIndex ?? "unavailable"}
                    </p>
                </div>
            )}
        </article>
    );
}

export function EvidencePage({
    overview,
    phase2,
    distributions,
    requestedEpochId,
    requestedHolderRef,
    loading,
    detailError,
    onRefresh,
    canRefresh,
}: {
    overview: Overview | null;
    phase2: Phase2 | null;
    distributions: Distributions | null;
    requestedEpochId: string | null;
    requestedHolderRef: string | null;
    loading: boolean;
    detailError: string | null;
    onRefresh: () => void;
    canRefresh: boolean;
}) {
    const epoch = requestedEpochId
        ? distributions?.epochs.find((item) => item.id === requestedEpochId)
        : distributions?.epochs[0];
    const entitlements = requestedHolderRef
        ? epoch?.entitlements.filter((item) => item.holderRef === requestedHolderRef)
        : epoch?.entitlements;
    const returnHref = requestedHolderRef
        ? `/demo?step=distribution&holder=${encodeURIComponent(requestedHolderRef)}`
        : "/demo?step=distribution";

    return (
        <div className="evidence-page">
            <div className="evidence-toolbar">
                <a href={returnHref}>Back to distribution walkthrough</a>
                <button type="button" disabled={!canRefresh} onClick={onRefresh}>
                    Refresh run evidence
                </button>
            </div>
            <div className="evidence-title">
                <p className="section-index">Current run / Read-only evidence</p>
                <h1>Trace the distribution.</h1>
                <p>
                    These records belong to the selected synthetic quarter and the network shown below. The
                    landing-page worked example is separate.
                </p>
            </div>
            {loading && <p role="status">Loading current run evidence…</p>}
            {detailError && (
                <p className="journey-data-error" role="alert">
                    {detailError}
                </p>
            )}
            {!loading && !distributions && (
                <p role="alert">
                    Distribution records could not be loaded. Return to the walkthrough and refresh the run.
                </p>
            )}
            {!loading && distributions && !epoch && (
                <p role="status">
                    {requestedEpochId
                        ? "The requested distribution run was not found in this scenario."
                        : "No distribution run has been prepared for this scenario yet."}
                </p>
            )}
            {epoch && distributions && (
                <>
                    <section className="evidence-run" aria-labelledby="evidence-run-heading">
                        <div className="evidence-run-head">
                            <div>
                                <p className="section-index">
                                    {epoch.quarter} · revision {epoch.revision}
                                </p>
                                <h2 id="evidence-run-heading">
                                    {epoch.approvedAt ? "Approved" : "Calculated, awaiting approval"} pool:{" "}
                                    {usd(epoch.poolUsdMinor)}
                                </h2>
                            </div>
                            <p>
                                <strong>{chainName(distributions.chainId)}</strong>
                                <br />
                                Chain ID {distributions.chainId}
                            </p>
                        </div>
                        <p
                            className={
                                epoch.state === "RECONCILIATION_REQUIRED"
                                    ? "journey-data-error"
                                    : "evidence-state"
                            }
                            role="status"
                        >
                            {stageStatus(epoch)}
                        </p>
                        <dl className="evidence-facts">
                            <div>
                                <dt>Run ID</dt>
                                <dd>
                                    <code>{epoch.id}</code>
                                </dd>
                            </div>
                            <div>
                                <dt>Issuer and source import</dt>
                                <dd>
                                    {overview?.issuer.displayName ?? "Fictional issuer"} ·{" "}
                                    <code>{epoch.importId}</code>
                                </dd>
                            </div>
                            <div>
                                <dt>Terms record</dt>
                                <dd>
                                    <code>{epoch.termsId}</code>
                                    {phase2?.terms?.id === epoch.termsId
                                        ? ` · prototype v${phase2.terms.version}`
                                        : ""}
                                </dd>
                            </div>
                            <div>
                                <dt>Formula</dt>
                                <dd>{epoch.formulaVersion}</dd>
                            </div>
                        </dl>
                    </section>

                    <section aria-labelledby="evidence-cash-heading">
                        <p className="section-index">01 / Cash calculation</p>
                        <h2 id="evidence-cash-heading">From approved cash to holder pool</h2>
                        <p>
                            Defined cash {usd(epoch.cashSnapshot.definedCashMinor)} ×{" "}
                            {epoch.cashSnapshot.participationBasisPoints / 100}% participation ={" "}
                            {usd(epoch.poolUsdMinor)} allocated pool. The API records the calculated result
                            and formula version above.
                        </p>
                        <dl className="evidence-facts">
                            <div>
                                <dt>Financial approval</dt>
                                <dd>
                                    <code>{epoch.cashSnapshot.financialApprovalId}</code>
                                </dd>
                            </div>
                            <div>
                                <dt>Distribution approval</dt>
                                <dd>
                                    {epoch.approvedAt
                                        ? `${epoch.approvedBy ?? "Reviewer unavailable"} · ${new Date(epoch.approvedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC`
                                        : "Pending"}
                                </dd>
                            </div>
                            <div>
                                <dt>Cash snapshot SHA-256</dt>
                                <dd>
                                    <code>{epoch.cashSnapshotSha256}</code>
                                </dd>
                            </div>
                        </dl>
                        <details className="evidence-periods">
                            <summary>Inspect monthly input lines and source records</summary>
                            {epoch.cashSnapshot.periods.map((period) => (
                                <article key={period.period}>
                                    <h3>
                                        {period.period} · defined cash{" "}
                                        {usd(period.definedDistributableCashMinor)}
                                    </h3>
                                    <dl className="evidence-facts">
                                        {Object.entries(period.lines).map(([category, line]) => (
                                            <div key={category}>
                                                <dt>
                                                    {category === "tax"
                                                        ? "Taxes"
                                                        : category === "debt"
                                                          ? "Debt service"
                                                          : category === "reserve"
                                                            ? "Reserve"
                                                            : category === "excluded"
                                                              ? "Exclusions"
                                                              : category === "operating"
                                                                ? "Operating expenses"
                                                                : "Eligible receipts"}
                                                </dt>
                                                <dd>
                                                    {usd(line.amountMinor)} ·{" "}
                                                    {line.sourceRefs.map((ref) => {
                                                        const source = epoch.cashSnapshot.sourceRows.find(
                                                            (row) => row.sourceRef === ref,
                                                        );
                                                        return (
                                                            <span className="evidence-source" key={ref}>
                                                                {ref} ·{" "}
                                                                {source?.evidenceRef ?? "source missing"} ·
                                                                SHA-256{" "}
                                                                <code>{source?.rowSha256 ?? "missing"}</code>
                                                            </span>
                                                        );
                                                    })}
                                                </dd>
                                            </div>
                                        ))}
                                    </dl>
                                </article>
                            ))}
                        </details>
                    </section>

                    <section aria-labelledby="evidence-snapshot-heading">
                        <p className="section-index">02 / Record date and allocation</p>
                        <h2 id="evidence-snapshot-heading">Frozen balances and entitlements</h2>
                        <dl className="evidence-facts">
                            <div>
                                <dt>Record block</dt>
                                <dd>{epoch.recordBlock ?? "Not frozen"}</dd>
                            </div>
                            <div>
                                <dt>Block hash</dt>
                                <dd>
                                    <code>{epoch.recordBlockHash ?? "Not frozen"}</code>
                                </dd>
                            </div>
                            <div>
                                <dt>Eligible snapshot supply</dt>
                                <dd>
                                    {epoch.recordBlock
                                        ? `${epoch.eligibleSupply} whole units`
                                        : "Pending snapshot"}
                                </dd>
                            </div>
                            <div>
                                <dt>Snapshot SHA-256</dt>
                                <dd>
                                    <code>{epoch.snapshotHash ?? "Pending snapshot"}</code>
                                </dd>
                            </div>
                            <div>
                                <dt>Entitlement root</dt>
                                <dd>
                                    <code>{epoch.entitlementRoot ?? "Pending snapshot"}</code>
                                </dd>
                            </div>
                        </dl>
                        {!entitlements?.length && (
                            <p>
                                {requestedHolderRef
                                    ? "No entitlement for the selected holder is visible to this action role."
                                    : "No entitlements have been frozen for this run."}
                            </p>
                        )}
                        {entitlements?.map((item) => (
                            <EntitlementRecord
                                key={item.index}
                                epoch={epoch}
                                entitlement={item}
                                chainId={distributions.chainId}
                            />
                        ))}
                    </section>

                    <section aria-labelledby="evidence-transactions-heading">
                        <p className="section-index">03 / Funding and claim transactions</p>
                        <h2 id="evidence-transactions-heading">Follow the recorded chain steps</h2>
                        <p>
                            {chainName(distributions.chainId)} · {testUsdc(epoch.poolTestUsdcMinor)} full
                            vault commitment. A transaction hash is evidence of submission or recording; the
                            run state above controls whether funding and claims are treated as complete.
                            {distributions.chainId === 31337 &&
                                " Local Anvil transactions are inspectable through the local RPC, not a public explorer."}
                        </p>
                        <dl className="evidence-facts">
                            <div>
                                <dt>Vault</dt>
                                <dd>
                                    <code>{epoch.vaultAddress ?? "Not deployed"}</code>
                                </dd>
                            </div>
                            <div>
                                <dt>Funding</dt>
                                <dd>
                                    {epoch.fundingTxHash ? (
                                        <Transaction
                                            chainId={distributions.chainId}
                                            hash={epoch.fundingTxHash}
                                        />
                                    ) : (
                                        "Not confirmed"
                                    )}
                                </dd>
                            </div>
                            <div>
                                <dt>Claim opening</dt>
                                <dd>
                                    {epoch.openingTxHash ? (
                                        <Transaction
                                            chainId={distributions.chainId}
                                            hash={epoch.openingTxHash}
                                        />
                                    ) : (
                                        "Not confirmed"
                                    )}
                                </dd>
                            </div>
                        </dl>
                        {epoch.chainSteps.length > 0 && (
                            <div className="evidence-chain-steps">
                                <h3>Confirmed chain step receipts</h3>
                                <ol>
                                    {epoch.chainSteps.map((item) => (
                                        <li key={item.step}>
                                            <strong>{item.step.replaceAll("_", " ").toLowerCase()}</strong> ·
                                            block {item.blockNumber} · chain {item.chainId}
                                            <br />
                                            Transaction{" "}
                                            <Transaction chainId={item.chainId} hash={item.txHash} />
                                            <br />
                                            Block hash <code>{item.blockHash}</code>
                                        </li>
                                    ))}
                                </ol>
                            </div>
                        )}
                        {epoch.reconciliationIncidents.length > 0 && (
                            <div className="evidence-incidents" role="alert">
                                <h3>Reconciliation incidents</h3>
                                <ul>
                                    {epoch.reconciliationIncidents.map((incident, index) => (
                                        <li key={`${incident.code}:${index}`}>
                                            {incident.code} ·{" "}
                                            {new Date(incident.createdAt).toLocaleString("en-GB", {
                                                timeZone: "UTC",
                                            })}{" "}
                                            UTC
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </section>
                </>
            )}

            <section className="evidence-historical" aria-labelledby="historical-heading">
                <p className="section-index">Separate historical evidence / Base Sepolia</p>
                <h2 id="historical-heading">Earlier restricted issuance</h2>
                <p>
                    This public Base Sepolia token and its two 600/400 issuance transactions are from an
                    earlier run. They are not evidence of funding or claims in the current{" "}
                    {distributions ? chainName(distributions.chainId) : "local"} distribution.
                </p>
                <p>
                    <a href={historicalIssuance.explorerUrl} target="_blank" rel="noreferrer">
                        View the verified participation token on BaseScan
                    </a>
                </p>
                <ul>
                    {historicalIssuance.issuance.holderUnits.map((holder) => (
                        <li key={holder.holderRef}>
                            {holder.units} units ·{" "}
                            {holder.holderRef.replace("synthetic-holder-", "fictional holder ")} ·{" "}
                            <a
                                href={`https://sepolia.basescan.org/tx/${holder.mintTransactionHash}`}
                                target="_blank"
                                rel="noreferrer"
                            >
                                View issuance transaction
                            </a>
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    );
}
