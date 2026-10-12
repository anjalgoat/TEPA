import { useEffect, useRef, useState } from "react";
import { encodeFunctionData, parseAbi } from "viem";
import { fetchSettlements, mutateSettlement, type DemoRole, type Settlements } from "./api.js";
import sample from "../../../data/fixtures/settlement/sample.v1.json";
import { chainName } from "./DemoJourney.js";
import { walletErrorMessage } from "./walletFeedback.js";

const holderName = (holderRef: string) =>
    `Fictional holder ${holderRef.replace("synthetic-holder-", "").toUpperCase()}`;

const vaultAbi = parseAbi(["function settle(uint256,uint256,uint256,bytes32[])"]);
const money = (minor: string) => {
    const value = BigInt(minor);
    const positive = value < 0n ? -value : value;
    return `${value < 0n ? "−" : ""}$${(positive / 100n).toLocaleString("en-US")}.${(positive % 100n).toString().padStart(2, "0")}`;
};
const cents = (value: string) => {
    if (!/^\d+(\.\d{1,2})?$/.test(value))
        throw new Error("Enter a USD amount with at most two decimal places.");
    const [whole, fraction = ""] = value.split(".");
    return (BigInt(whole!) * 100n + BigInt((fraction + "00").slice(0, 2))).toString();
};
const inputUsd = (minor: string) => {
    const value = BigInt(minor);
    return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
};
const usdc = (minor: string) => {
    const value = BigInt(minor);
    return `${(value / 1_000_000n).toLocaleString("en-US")}.${(value % 1_000_000n).toString().padStart(6, "0")} test USDC`;
};
const explorer = (chainId: number, tx: string) =>
    chainId === 84532 ? `https://sepolia.basescan.org/tx/${tx}` : null;
const ownRef = (role: DemoRole) =>
    role === "INVESTOR_A" ? "synthetic-holder-a" : role === "INVESTOR_B" ? "synthetic-holder-b" : null;
const holderRole = (holderRef: string): DemoRole =>
    holderRef === "synthetic-holder-b" ? "INVESTOR_B" : "INVESTOR_A";
const sampleAssumptions = {
    cashAndDebt: sample.appraisal.assumptions.cashAndDebt,
    dilution: sample.appraisal.assumptions.dilution,
    pastDistributions: sample.appraisal.assumptions.pastDistributions,
    tepaObligation: "BEFORE_TEPA_ALLOCATION" as const,
};
type Case = Settlements["cases"][number];

export function SettlementPanel({
    token,
    role,
    issuerVersion,
    onChange,
    mode = "buyback",
    selectedHolderRef,
    sessionForRole,
}: {
    token: string | null;
    role: DemoRole;
    issuerVersion: number | null;
    onChange: () => Promise<void>;
    mode?: "buyback" | "acquisition";
    selectedHolderRef?: string;
    sessionForRole?: (role: DemoRole) => Promise<string>;
}) {
    const [data, setData] = useState<Settlements | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [pending, setPending] = useState<string | null>(null);
    const [appraisedValue, setAppraisedValue] = useState(inputUsd(sample.appraisal.appraisedEquityUsdMinor));
    const [budget, setBudget] = useState(inputUsd(sample.buyback.budgetUsdMinor));
    const [price, setPrice] = useState(inputUsd(sample.buyback.bindingUnitPriceUsdMinor));
    const [tenderUnits, setTenderUnits] = useState(sample.buyback.tenders[0]!.tenderedUnits);
    const [gross, setGross] = useState(inputUsd(sample.acquisition.grossConsiderationUsdMinor));
    const [costs, setCosts] = useState(inputUsd(sample.acquisition.transactionCostsUsdMinor));
    const [senior, setSenior] = useState(inputUsd(sample.acquisition.debtAndSeniorObligationsUsdMinor));
    const [reserves, setReserves] = useState(inputUsd(sample.acquisition.taxesAndRequiredReservesUsdMinor));
    const [other, setOther] = useState(inputUsd(sample.acquisition.disclosedOtherDeductionsUsdMinor));
    const [otherReason, setOtherReason] = useState("");
    const [cancelReason, setCancelReason] = useState("");
    const [recoveryReason, setRecoveryReason] = useState("");
    const [deadline, setDeadline] = useState(() => {
        // Short default so a recorded demo can close tenders soon; the API still enforces the deadline.
        const date = new Date(Date.now() + 3 * 60_000);
        return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    });
    const version = useRef(0);
    const keys = useRef(new Map<string, string>());
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
        fetchSettlements(token)
            .then((result) => {
                if (active) {
                    version.current = result.issuerVersion;
                    setData(result);
                }
            })
            .catch((cause) => {
                if (active)
                    setError(
                        cause instanceof Error ? cause.message : "Settlement records could not be loaded.",
                    );
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, [token, role, issuerVersion]);
    async function refresh() {
        if (!token) return;
        const result = await fetchSettlements(token);
        version.current = result.issuerVersion;
        setData(result);
        await onChange();
    }
    async function act(label: string, path: string, body: unknown, reason: string, requiredRole?: DemoRole) {
        if (!token || !data) return;
        const keyName = `${label}:${version.current}`;
        const key = keys.current.get(keyName) ?? crypto.randomUUID();
        keys.current.set(keyName, key);
        setPending(label);
        setError(null);
        setNotice(null);
        try {
            const actionRole: DemoRole = path.includes("/tenders")
                ? selectedHolderRef === "synthetic-holder-b"
                    ? "INVESTOR_B"
                    : "INVESTOR_A"
                : path.endsWith("/approve") || path.endsWith("/review")
                  ? "FINANCE_REVIEWER"
                  : path === "/api/v1/appraisals" ||
                      path === "/api/v1/buybacks" ||
                      path === "/api/v1/acquisitions" ||
                      (path.endsWith("/cancel") && !path.includes("/tenders")) ||
                      path.endsWith("/open")
                    ? "ISSUER_PREPARER"
                    : "DISTRIBUTION_OPERATOR";
            const actionToken = sessionForRole ? await sessionForRole(requiredRole ?? actionRole) : token;
            const operation = await mutateSettlement(actionToken, path, body, version.current, reason, key);
            keys.current.delete(keyName);
            version.current = operation.resourceVersion;
            await refresh();
            if (operation.status === "PENDING")
                setNotice(
                    "Chain action queued. The settlement worker must confirm it before this case advances.",
                );
        } catch (cause) {
            setError(
                cause instanceof Error ? cause.message : "The settlement action failed. Refresh and retry.",
            );
        } finally {
            setPending(null);
        }
    }
    async function settle(value: Case, holderRef: string) {
        const own = value.allocations.find((row) => row.holder_ref === holderRef);
        if (!token || !data || !own || !value.vault_address) return;
        setPending(`settle:${value.id}`);
        setError(null);
        setNotice(null);
        try {
            const storageKey = `tepa-pending-settlement:${value.id}:${own.id}`;
            let txHash = localStorage.getItem(storageKey);
            if (!txHash) {
                if (!window.ethereum)
                    throw new Error("Connect the bound fictional holder wallet to receive test USDC.");
                const chainHex = await window.ethereum.request({ method: "eth_chainId" });
                if (Number.parseInt(String(chainHex), 16) !== data.chainId)
                    throw new Error(
                        `Switch your wallet to ${chainName(data.chainId)} (chain ${data.chainId}) and try again.`,
                    );
                const accounts = (await window.ethereum.request({
                    method: "eth_requestAccounts",
                })) as string[];
                const account = accounts[0];
                if (!account || account.toLowerCase() !== own.wallet_address.toLowerCase())
                    throw new Error("Select the wallet bound to this fictional holder.");
                txHash = (await window.ethereum.request({
                    method: "eth_sendTransaction",
                    params: [
                        {
                            from: account,
                            to: value.vault_address,
                            data: encodeFunctionData({
                                abi: vaultAbi,
                                functionName: "settle",
                                args: [
                                    BigInt(own.leaf_index),
                                    BigInt(own.accepted_units),
                                    BigInt(own.amount_test_usdc_minor),
                                    own.proof as `0x${string}`[],
                                ],
                            }),
                        },
                    ],
                })) as string;
            }
            if (!/^0x[0-9a-fA-F]{64}$/.test(txHash))
                throw new Error("Wallet did not return a transaction hash.");
            localStorage.setItem(storageKey, txHash);
            setNotice(`Payment submitted: ${txHash}. Waiting for confirmation.`);
            const receiptToken = sessionForRole
                ? await sessionForRole(own.holder_ref === "synthetic-holder-b" ? "INVESTOR_B" : "INVESTOR_A")
                : token;
            for (let attempt = 0; attempt < 15; attempt++) {
                try {
                    await mutateSettlement(
                        receiptToken,
                        `/api/v1/${value.kind === "BUYBACK" ? "buybacks" : "acquisitions"}/${value.id}/receipts`,
                        { txHash },
                        version.current,
                        "Record confirmed fictional settlement payment",
                        crypto.randomUUID(),
                    );
                    localStorage.removeItem(storageKey);
                    await refresh();
                    setNotice("Test USDC payment and the matching unit burn are recorded.");
                    return;
                } catch (cause) {
                    const message = cause instanceof Error ? cause.message : "Confirmation pending.";
                    if (!/not confirmed|three chain confirmations/i.test(message)) throw cause;
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }
            }
            setNotice(
                "Payment is still confirming. The transaction hash is saved in this browser for another attempt.",
            );
        } catch (cause) {
            await refresh().catch(() => undefined);
            setError(walletErrorMessage(cause, "The payment could not be recorded."));
        } finally {
            setPending(null);
        }
    }
    const preparer = Boolean(sessionForRole) || role === "ISSUER_PREPARER";
    const reviewer = Boolean(sessionForRole) || role === "FINANCE_REVIEWER";
    const operator = Boolean(sessionForRole) || role === "DISTRIBUTION_OPERATOR";
    const investor = Boolean(sessionForRole) || ownRef(role) !== null;
    const viewRole: DemoRole =
        selectedHolderRef === "synthetic-holder-b"
            ? "INVESTOR_B"
            : selectedHolderRef === "synthetic-holder-a"
              ? "INVESTOR_A"
              : role;
    const approvedAppraisal = data?.appraisals.filter((row) => row.state === "APPROVED").at(-1);
    const activeBuyback = data?.cases.some(
        (row) => row.kind === "BUYBACK" && !["CLOSED", "CANCELLED", "EXPIRED"].includes(row.state),
    );
    const finishedBuyback = data?.cases.some(
        (row) => row.kind === "BUYBACK" && ["CLOSED", "CANCELLED", "EXPIRED"].includes(row.state),
    );
    const acquisition = data?.cases
        .filter((row) => row.kind === "ACQUISITION" && row.state !== "CANCELLED")
        .at(-1);
    return (
        <section className="settlement" aria-labelledby="settlement-heading">
            <div className="section-heading">
                <div>
                    <p className="section-index">
                        {mode === "buyback" ? "06 / Buyback" : "07 / Acquisition"}
                    </p>
                    <h2 id="settlement-heading">
                        {mode === "buyback"
                            ? "Price, tender and paid burn"
                            : "Net proceeds and terminal settlement"}
                    </h2>
                </div>
                <p>Fictional appraisal · budgeted test USDC · restricted units</p>
            </div>
            <p className="prototype-notice distribution-notice" role="note">
                Prototype only. Fictional issuer and investors. No real securities are offered, no real money
                is accepted, and testnet tokens have no financial value.
            </p>
            <p>
                The estimate is informational and cannot be withdrawn. A buyback accepts only units covered by
                its approved budget and funded test USDC. Acquisition terms shown here are sample assumptions
                requiring legal review.
            </p>
            {loading && <p role="status">Loading appraisal and settlement evidence…</p>}
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
                <p>Settlement records are unavailable. Check the API, then reload the workspace.</p>
            )}
            {mode === "buyback" && (
                <>
                    {data && data.appraisals.length === 0 && !preparer && (
                        <p className="phase2-empty">
                            No fictional appraisal has been prepared. View as the issuer to enter the sample
                            value and assumptions.
                        </p>
                    )}
                    {data && preparer && data.appraisals.length === 0 && (
                        <div className="settlement-form">
                            <h3>Record a fictional independent appraisal</h3>
                            <label>
                                Adjusted equity value before TEPA allocation, USD
                                <input
                                    inputMode="decimal"
                                    value={appraisedValue}
                                    onChange={(event) => setAppraisedValue(event.target.value)}
                                />
                            </label>
                            <p>
                                Sample date: {sample.appraisal.valuationDate}. Method:{" "}
                                {sample.appraisal.methodology}. Evidence: {sample.appraisal.evidenceRef}.{" "}
                                {sampleAssumptions.cashAndDebt}; {sampleAssumptions.dilution};{" "}
                                {sampleAssumptions.pastDistributions}.
                            </p>
                            <button
                                type="button"
                                disabled={pending !== null}
                                onClick={() => {
                                    try {
                                        const body = {
                                            appraisedEquityUsdMinor: cents(appraisedValue),
                                            participationBasisPoints:
                                                sample.appraisal.participationBasisPoints,
                                            outstandingEligibleUnits:
                                                sample.appraisal.outstandingEligibleUnits,
                                            valuationDate: sample.appraisal.valuationDate,
                                            methodology: sample.appraisal.methodology,
                                            evidenceRef: sample.appraisal.evidenceRef,
                                            assumptions: sampleAssumptions,
                                        };
                                        void act(
                                            "appraisal",
                                            "/api/v1/appraisals",
                                            body,
                                            "Record the fictional independent sample appraisal",
                                        );
                                    } catch (cause) {
                                        setError(
                                            cause instanceof Error
                                                ? cause.message
                                                : "Enter a valid appraisal value.",
                                        );
                                    }
                                }}
                            >
                                Record sample appraisal
                            </button>
                        </div>
                    )}
                    {data?.appraisals.map((row) => (
                        <div className="settlement-appraisal" key={row.id}>
                            <div>
                                <p className="section-index">
                                    Informational estimate · {row.state.toLowerCase()}
                                </p>
                                <h3>{money(row.indicative_unit_usd_minor)} per remaining unit</h3>
                                <p>
                                    Appraised equity {money(row.input.appraisedEquityUsdMinor)} before the 10%
                                    sample TEPA allocation. Pool estimate {money(row.pool_usd_minor)} across{" "}
                                    {row.input.outstandingEligibleUnits} units.
                                </p>
                                <p>
                                    Valuation date {row.input.valuationDate}. {row.input.methodology}.
                                    Evidence {row.input.evidenceRef}.
                                </p>
                                <details>
                                    <summary>Appraisal assumptions</summary>
                                    <p>
                                        {row.input.assumptions.cashAndDebt}. {row.input.assumptions.dilution}.{" "}
                                        {row.input.assumptions.pastDistributions}. TEPA allocation has not yet
                                        been deducted.
                                    </p>
                                </details>
                            </div>
                            {reviewer && row.state === "DRAFT" && (
                                <button
                                    type="button"
                                    disabled={pending !== null}
                                    onClick={() =>
                                        void act(
                                            `approve-appraisal:${row.id}`,
                                            `/api/v1/appraisals/${row.id}/approve`,
                                            {},
                                            "Approve the reviewed fictional appraisal",
                                        )
                                    }
                                >
                                    Approve sample appraisal
                                </button>
                            )}
                            <p className="settlement-noncash">
                                This estimate is not cash, a claim, or a redemption right.
                            </p>
                        </div>
                    ))}
                    {data && preparer && approvedAppraisal && !activeBuyback && !finishedBuyback && (
                        <div className="settlement-form">
                            <h3>Prepare a budgeted buyback window</h3>
                            <div className="settlement-fields">
                                <label>
                                    Maximum company budget, USD
                                    <input
                                        inputMode="decimal"
                                        value={budget}
                                        onChange={(event) => setBudget(event.target.value)}
                                    />
                                </label>
                                <label>
                                    Proposed unit price, USD
                                    <input
                                        inputMode="decimal"
                                        value={price}
                                        onChange={(event) => setPrice(event.target.value)}
                                    />
                                </label>
                                <label>
                                    Tender deadline, local time
                                    <input
                                        type="datetime-local"
                                        value={deadline}
                                        onChange={(event) => setDeadline(event.target.value)}
                                    />
                                </label>
                            </div>
                            <p>
                                Acceptance can be less than the tendered amount. The approved price remains
                                funding pending until the settlement vault holds the full accepted amount.
                            </p>
                            <button
                                type="button"
                                disabled={pending !== null}
                                onClick={() => {
                                    try {
                                        void act(
                                            "prepare-buyback",
                                            "/api/v1/buybacks",
                                            {
                                                appraisalId: approvedAppraisal.id,
                                                budgetUsdMinor: cents(budget),
                                                bindingUnitPriceUsdMinor: cents(price),
                                                tenderDeadline: new Date(deadline).toISOString(),
                                            },
                                            "Prepare fictional issuer-funded buyback window",
                                        );
                                    } catch (cause) {
                                        setError(
                                            cause instanceof Error
                                                ? cause.message
                                                : "Enter a valid budget, price, and deadline.",
                                        );
                                    }
                                }}
                            >
                                Prepare buyback window
                            </button>
                        </div>
                    )}
                    {data?.cases
                        .filter((row) => row.kind === "BUYBACK")
                        .map((value) => (
                            <article className="settlement-case" key={value.id}>
                                <div className="settlement-case-head">
                                    <div>
                                        <p className="section-index">
                                            Issuer-funded buyback ·{" "}
                                            {value.state.replaceAll("_", " ").toLowerCase()}
                                        </p>
                                        <h3>
                                            {money(value.binding_unit_price_usd_minor!)}{" "}
                                            {value.priceStatus === "FUNDED_BINDING"
                                                ? "funded price"
                                                : "proposed price"}{" "}
                                            per unit
                                        </h3>
                                        <p>
                                            Budget {money(value.budget_usd_minor!)} · tender deadline{" "}
                                            {new Date(value.tender_deadline!).toLocaleString("en-GB")}
                                        </p>
                                        <p>
                                            {value.priceStatus === "FUNDED_BINDING"
                                                ? "Accepted price funded in test USDC."
                                                : "Funding pending. Tenders are requests, not guaranteed acceptance."}
                                        </p>
                                    </div>
                                    <div className="settlement-actions">
                                        {reviewer && value.state === "DRAFT" && (
                                            <button
                                                type="button"
                                                disabled={pending !== null}
                                                onClick={() =>
                                                    void act(
                                                        `approve:${value.id}`,
                                                        `/api/v1/buybacks/${value.id}/approve`,
                                                        {},
                                                        "Approve the fictional budget and proposed unit price",
                                                    )
                                                }
                                            >
                                                Approve buyback terms
                                            </button>
                                        )}
                                        {preparer && value.state === "APPROVED" && (
                                            <button
                                                type="button"
                                                disabled={pending !== null}
                                                onClick={() =>
                                                    void act(
                                                        `open:${value.id}`,
                                                        `/api/v1/buybacks/${value.id}/open`,
                                                        {},
                                                        "Open fictional holder tender window",
                                                    )
                                                }
                                            >
                                                Open tender window
                                            </button>
                                        )}
                                        {operator &&
                                            value.state === "OPEN" &&
                                            new Date(value.tender_deadline!).getTime() <= Date.now() && (
                                                <button
                                                    type="button"
                                                    disabled={pending !== null}
                                                    onClick={() =>
                                                        void act(
                                                            `close:${value.id}`,
                                                            `/api/v1/buybacks/${value.id}/close-tenders`,
                                                            {},
                                                            "Close tender window after stated deadline",
                                                        )
                                                    }
                                                >
                                                    Close expired tenders
                                                </button>
                                            )}
                                        {operator && value.state === "TENDER_CLOSED" && (
                                            <button
                                                type="button"
                                                disabled={pending !== null}
                                                onClick={() =>
                                                    void act(
                                                        `allocate:${value.id}`,
                                                        `/api/v1/buybacks/${value.id}/allocate`,
                                                        {},
                                                        "Allocate oversubscribed tenders by frozen holdings",
                                                    )
                                                }
                                            >
                                                Allocate accepted tenders
                                            </button>
                                        )}
                                        {operator &&
                                            value.state === "TENDER_CLOSED" &&
                                            !value.tenders.some(
                                                (row) =>
                                                    row.status === "ACTIVE" &&
                                                    row.holder_ref === (selectedHolderRef ?? ownRef(role)),
                                            ) && (
                                                <button
                                                    type="button"
                                                    disabled={pending !== null}
                                                    onClick={() =>
                                                        void act(
                                                            `expire:${value.id}`,
                                                            `/api/v1/buybacks/${value.id}/expire-empty`,
                                                            {},
                                                            "Expire empty fictional tender window",
                                                        )
                                                    }
                                                >
                                                    Expire empty window
                                                </button>
                                            )}
                                        {operator && value.state === "ALLOCATED" && (
                                            <button
                                                type="button"
                                                disabled={pending !== null}
                                                onClick={() =>
                                                    void act(
                                                        `fund:${value.id}`,
                                                        `/api/v1/buybacks/${value.id}/fund`,
                                                        {},
                                                        "Fund accepted fictional tenders with test USDC",
                                                    )
                                                }
                                            >
                                                Queue vault funding
                                            </button>
                                        )}
                                        {operator && value.state === "SETTLED" && (
                                            <button
                                                type="button"
                                                disabled={pending !== null}
                                                onClick={() =>
                                                    void act(
                                                        `finalize:${value.id}`,
                                                        `/api/v1/buybacks/${value.id}/finalize`,
                                                        {},
                                                        "Close buyback after all holder outcomes",
                                                    )
                                                }
                                            >
                                                Queue buyback closure
                                            </button>
                                        )}
                                    </div>
                                </div>
                                {preparer &&
                                    ["DRAFT", "APPROVED", "OPEN", "TENDER_CLOSED"].includes(value.state) && (
                                        <div className="settlement-cancel">
                                            <label>
                                                Reason to cancel this unfunded window
                                                <textarea
                                                    rows={2}
                                                    value={cancelReason}
                                                    onChange={(event) => setCancelReason(event.target.value)}
                                                />
                                            </label>
                                            <button
                                                type="button"
                                                disabled={pending !== null || cancelReason.trim().length < 8}
                                                onClick={() =>
                                                    void act(
                                                        `cancel-case:${value.id}`,
                                                        `/api/v1/buybacks/${value.id}/cancel`,
                                                        {},
                                                        cancelReason.trim(),
                                                    )
                                                }
                                            >
                                                Cancel window
                                            </button>
                                        </div>
                                    )}
                                {operator && value.state === "RECONCILIATION_REQUIRED" && (
                                    <div className="settlement-cancel">
                                        <label>
                                            Reviewed retry reason
                                            <textarea
                                                rows={2}
                                                value={recoveryReason}
                                                onChange={(event) => setRecoveryReason(event.target.value)}
                                            />
                                        </label>
                                        <button
                                            type="button"
                                            disabled={pending !== null || recoveryReason.trim().length < 8}
                                            onClick={() =>
                                                void act(
                                                    `resume:${value.id}`,
                                                    `/api/v1/buybacks/${value.id}/resume`,
                                                    {},
                                                    recoveryReason.trim(),
                                                )
                                            }
                                        >
                                            Retry reviewed chain step
                                        </button>
                                    </div>
                                )}
                                {investor && value.state === "OPEN" && (
                                    <div className="settlement-tender">
                                        <label>
                                            Units to tender
                                            <input
                                                type="number"
                                                min="1"
                                                max="1000"
                                                step="1"
                                                value={tenderUnits}
                                                onChange={(event) => setTenderUnits(event.target.value)}
                                            />
                                        </label>
                                        {(sessionForRole
                                            ? ["synthetic-holder-a", "synthetic-holder-b"]
                                            : [ownRef(role)]
                                        )
                                            .filter((ref): ref is string => Boolean(ref))
                                            .map((ref) => {
                                                const activeTender = value.tenders.find(
                                                    (row) =>
                                                        row.holder_ref === ref && row.status === "ACTIVE",
                                                );
                                                return activeTender ? (
                                                    <div key={ref}>
                                                        <p>
                                                            {ref === "synthetic-holder-b"
                                                                ? "Holder B"
                                                                : "Holder A"}
                                                            : {activeTender.tendered_units} units tendered.
                                                        </p>
                                                        <button
                                                            type="button"
                                                            disabled={pending !== null}
                                                            onClick={() =>
                                                                void act(
                                                                    `cancel:${activeTender.id}`,
                                                                    `/api/v1/buybacks/${value.id}/tenders/${activeTender.id}/cancel`,
                                                                    {},
                                                                    "Cancel this fictional tender before deadline",
                                                                    holderRole(ref),
                                                                )
                                                            }
                                                        >
                                                            Cancel{" "}
                                                            {ref === "synthetic-holder-b"
                                                                ? "holder B"
                                                                : "holder A"}{" "}
                                                            tender
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <button
                                                        key={ref}
                                                        type="button"
                                                        disabled={
                                                            pending !== null || !/^\d+$/.test(tenderUnits)
                                                        }
                                                        onClick={() =>
                                                            void act(
                                                                `tender:${value.id}:${ref}`,
                                                                `/api/v1/buybacks/${value.id}/tenders`,
                                                                { units: Number(tenderUnits) },
                                                                "Submit fictional holder tender before deadline",
                                                                holderRole(ref),
                                                            )
                                                        }
                                                    >
                                                        Submit{" "}
                                                        {ref === "synthetic-holder-b"
                                                            ? "holder B"
                                                            : "holder A"}{" "}
                                                        tender
                                                    </button>
                                                );
                                            })}
                                    </div>
                                )}
                                {value.tenders.length > 0 &&
                                    ["ALLOCATED", "FUNDED", "SETTLED", "CLOSED", "EXPIRED"].includes(
                                        value.state,
                                    ) && (
                                        <div className="settlement-tender-results">
                                            <h4>Tender outcomes</h4>
                                            <ul>
                                                {value.tenders
                                                    .filter((row) => row.status === "ACTIVE")
                                                    .map((tender) => {
                                                        const accepted =
                                                            value.allocations.find(
                                                                (row) => row.holder_ref === tender.holder_ref,
                                                            )?.accepted_units ?? 0;
                                                        return (
                                                            <li key={tender.id}>
                                                                {holderName(tender.holder_ref)}:{" "}
                                                                {tender.tendered_units} tendered; {accepted}{" "}
                                                                accepted; {tender.tendered_units - accepted}{" "}
                                                                remain with the holder.
                                                            </li>
                                                        );
                                                    })}
                                            </ul>
                                        </div>
                                    )}
                                <SettlementEvidence
                                    value={value}
                                    chainId={data.chainId}
                                    investor={investor}
                                    role={viewRole}
                                    pending={pending}
                                    settle={settle}
                                    autoRoles={Boolean(sessionForRole)}
                                />
                            </article>
                        ))}
                </>
            )}
            {mode === "acquisition" && (
                <>
                    {data && preparer && finishedBuyback && !activeBuyback && !acquisition && (
                        <div className="settlement-form">
                            <h3>Enter the fictional acquisition waterfall</h3>
                            <div className="settlement-fields">
                                {[
                                    ["Gross consideration", gross, setGross],
                                    ["Transaction costs", costs, setCosts],
                                    ["Debt and senior obligations", senior, setSenior],
                                    ["Taxes and required reserves", reserves, setReserves],
                                    ["Other disclosed deductions", other, setOther],
                                ].map(([label, value, setter]) => (
                                    <label key={label as string}>
                                        {label as string}, USD
                                        <input
                                            inputMode="decimal"
                                            value={value as string}
                                            onChange={(event) =>
                                                (setter as (value: string) => void)(event.target.value)
                                            }
                                        />
                                    </label>
                                ))}
                                <label>
                                    Other deduction description
                                    <input
                                        value={otherReason}
                                        onChange={(event) => setOtherReason(event.target.value)}
                                    />
                                </label>
                            </div>
                            <p>
                                Earn-outs, escrows, non-cash consideration, rollover and partial sales remain
                                unresolved. This example assumes cash consideration with the stated
                                deductions.
                            </p>
                            <button
                                type="button"
                                disabled={pending !== null}
                                onClick={() => {
                                    try {
                                        void act(
                                            "prepare-acquisition",
                                            "/api/v1/acquisitions",
                                            {
                                                grossConsiderationUsdMinor: cents(gross),
                                                transactionCostsUsdMinor: cents(costs),
                                                debtAndSeniorObligationsUsdMinor: cents(senior),
                                                taxesAndRequiredReservesUsdMinor: cents(reserves),
                                                disclosedOtherDeductionsUsdMinor: cents(other),
                                                otherDeductionsDescription: otherReason,
                                                participationBasisPoints:
                                                    sample.acquisition.participationBasisPoints,
                                            },
                                            "Record disclosed fictional acquisition waterfall",
                                        );
                                    } catch (cause) {
                                        setError(
                                            cause instanceof Error
                                                ? cause.message
                                                : "Enter valid waterfall amounts.",
                                        );
                                    }
                                }}
                            >
                                Prepare acquisition settlement
                            </button>
                        </div>
                    )}
                    {acquisition && data && (
                        <article className="settlement-case">
                            <div className="settlement-case-head">
                                <div>
                                    <p className="section-index">
                                        Acquisition · {acquisition.state.replaceAll("_", " ").toLowerCase()}
                                    </p>
                                    <h3>
                                        {acquisition.committed_usd_minor
                                            ? money(acquisition.committed_usd_minor)
                                            : "Settlement pool pending"}
                                    </h3>
                                    <p>
                                        Gross {money(String(acquisition.input.grossConsiderationUsdMinor))};
                                        costs {money(String(acquisition.input.transactionCostsUsdMinor))};
                                        debt and senior obligations{" "}
                                        {money(String(acquisition.input.debtAndSeniorObligationsUsdMinor))};
                                        taxes and reserves{" "}
                                        {money(String(acquisition.input.taxesAndRequiredReservesUsdMinor))};
                                        other disclosed deductions{" "}
                                        {money(String(acquisition.input.disclosedOtherDeductionsUsdMinor))}.
                                    </p>
                                    <p>
                                        After deductions, the sample participation rate is 10% of positive
                                        defined net proceeds. Holder amounts use the remaining eligible units
                                        at the record block.
                                    </p>
                                </div>
                                <div className="settlement-actions">
                                    {reviewer && acquisition.state === "DRAFT" && (
                                        <button
                                            type="button"
                                            disabled={pending !== null}
                                            onClick={() =>
                                                void act(
                                                    `review:${acquisition.id}`,
                                                    `/api/v1/acquisitions/${acquisition.id}/review`,
                                                    {},
                                                    "Review fictional acquisition evidence and deductions",
                                                )
                                            }
                                        >
                                            Review waterfall evidence
                                        </button>
                                    )}
                                    {reviewer && acquisition.state === "EVIDENCE_REVIEW" && (
                                        <button
                                            type="button"
                                            disabled={pending !== null}
                                            onClick={() =>
                                                void act(
                                                    `approve:${acquisition.id}`,
                                                    `/api/v1/acquisitions/${acquisition.id}/approve`,
                                                    {},
                                                    "Approve fictional acquisition waterfall",
                                                )
                                            }
                                        >
                                            Approve waterfall
                                        </button>
                                    )}
                                    {operator && acquisition.state === "APPROVED" && (
                                        <button
                                            type="button"
                                            disabled={pending !== null}
                                            onClick={() =>
                                                void act(
                                                    `snapshot:${acquisition.id}`,
                                                    `/api/v1/acquisitions/${acquisition.id}/snapshot`,
                                                    {},
                                                    "Freeze remaining eligible units at record block",
                                                )
                                            }
                                        >
                                            Freeze remaining units
                                        </button>
                                    )}
                                    {operator && acquisition.state === "SNAPSHOTTED" && (
                                        <button
                                            type="button"
                                            disabled={pending !== null}
                                            onClick={() =>
                                                void act(
                                                    `fund:${acquisition.id}`,
                                                    `/api/v1/acquisitions/${acquisition.id}/fund`,
                                                    {},
                                                    "Fund fictional acquisition settlement vault",
                                                )
                                            }
                                        >
                                            Queue settlement funding
                                        </button>
                                    )}
                                    {operator &&
                                        acquisition.state === "CLAIMABLE" &&
                                        acquisition.allocations.every((row) => row.tx_hash) && (
                                            <button
                                                type="button"
                                                disabled={pending !== null}
                                                onClick={() =>
                                                    void act(
                                                        `finalize:${acquisition.id}`,
                                                        `/api/v1/acquisitions/${acquisition.id}/finalize`,
                                                        {},
                                                        "Close acquisition after every paid holder outcome",
                                                    )
                                                }
                                            >
                                                Queue terminal closure
                                            </button>
                                        )}
                                </div>
                            </div>
                            {preparer &&
                                ["DRAFT", "EVIDENCE_REVIEW", "APPROVED"].includes(acquisition.state) && (
                                    <div className="settlement-cancel">
                                        <label>
                                            Reason to cancel this pre-snapshot acquisition
                                            <textarea
                                                rows={2}
                                                value={cancelReason}
                                                onChange={(event) => setCancelReason(event.target.value)}
                                            />
                                        </label>
                                        <button
                                            type="button"
                                            disabled={pending !== null || cancelReason.trim().length < 8}
                                            onClick={() =>
                                                void act(
                                                    `cancel-case:${acquisition.id}`,
                                                    `/api/v1/acquisitions/${acquisition.id}/cancel`,
                                                    {},
                                                    cancelReason.trim(),
                                                )
                                            }
                                        >
                                            Cancel acquisition case
                                        </button>
                                    </div>
                                )}
                            {operator && acquisition.state === "RECONCILIATION_REQUIRED" && (
                                <div className="settlement-cancel">
                                    <label>
                                        Reviewed retry reason
                                        <textarea
                                            rows={2}
                                            value={recoveryReason}
                                            onChange={(event) => setRecoveryReason(event.target.value)}
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        disabled={pending !== null || recoveryReason.trim().length < 8}
                                        onClick={() =>
                                            void act(
                                                `resume:${acquisition.id}`,
                                                `/api/v1/acquisitions/${acquisition.id}/resume`,
                                                {},
                                                recoveryReason.trim(),
                                            )
                                        }
                                    >
                                        Retry reviewed chain step
                                    </button>
                                </div>
                            )}
                            <SettlementEvidence
                                value={acquisition}
                                chainId={data.chainId}
                                investor={investor}
                                role={viewRole}
                                pending={pending}
                                settle={settle}
                                autoRoles={Boolean(sessionForRole)}
                            />
                        </article>
                    )}
                </>
            )}
        </section>
    );
}

function SettlementEvidence({
    value,
    chainId,
    investor,
    role,
    pending,
    settle,
    autoRoles,
}: {
    value: Case;
    chainId: number;
    investor: boolean;
    role: DemoRole;
    pending: string | null;
    settle: (value: Case, holderRef: string) => Promise<void>;
    autoRoles: boolean;
}) {
    return (
        <div className="settlement-evidence">
            {value.state === "RECONCILIATION_REQUIRED" && (
                <p className="phase2-error" role="alert">
                    A chain or database step needs reconciliation. This case is not final or payable until the
                    evidence is reviewed.
                </p>
            )}
            <div className="settlement-ledger">
                <h4>Frozen holder outcomes</h4>
                {value.allocations.length === 0 ? (
                    <p>
                        Holder amounts will appear after the record block and deterministic allocation are
                        fixed.
                    </p>
                ) : (
                    <ul>
                        {value.allocations.map((row) => (
                            <li key={row.id}>
                                <strong>{holderName(row.holder_ref)}</strong>
                                <span>
                                    {row.accepted_units} of {row.snapshot_units} snapshot units ·{" "}
                                    {money(row.amount_usd_minor)} · {usdc(row.amount_test_usdc_minor)}
                                </span>
                                <span>
                                    {value.kind === "BUYBACK"
                                        ? `${row.snapshot_units - row.accepted_units} units remain with this holder if paid`
                                        : "All listed remaining units close after payment"}
                                    . Remainder {row.remainder}.
                                </span>
                                {row.tx_hash ? (
                                    <span>
                                        Paid and burned at block {row.block_number}.{" "}
                                        {explorer(chainId, row.tx_hash) ? (
                                            <a
                                                href={explorer(chainId, row.tx_hash)!}
                                                target="_blank"
                                                rel="noreferrer"
                                            >
                                                View payment on BaseScan
                                            </a>
                                        ) : (
                                            <code>{row.tx_hash}</code>
                                        )}
                                    </span>
                                ) : (
                                    investor &&
                                    (autoRoles || row.holder_ref === ownRef(role)) &&
                                    ((value.kind === "BUYBACK" && value.state === "FUNDED") ||
                                        (value.kind === "ACQUISITION" && value.state === "CLAIMABLE")) && (
                                        <button
                                            type="button"
                                            disabled={pending !== null}
                                            onClick={() => void settle(value, row.holder_ref)}
                                        >
                                            {localStorage.getItem(
                                                `tepa-pending-settlement:${value.id}:${row.id}`,
                                            )
                                                ? "Record existing payment"
                                                : `Receive test USDC and burn accepted units (${row.holder_ref === "synthetic-holder-b" ? "holder B" : "holder A"})`}
                                        </button>
                                    )
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <div className="settlement-chain">
                <h4>Record block and chain evidence</h4>
                <p>{value.record_block ? `Record block ${value.record_block}` : "Record block pending"}</p>
                {value.record_block_hash && (
                    <p>
                        Block hash <code>{value.record_block_hash}</code>
                    </p>
                )}
                {value.entitlement_root && (
                    <p>
                        Frozen entitlement root <code>{value.entitlement_root}</code>
                    </p>
                )}
                {value.vault_address && (
                    <p>
                        Settlement vault <code>{value.vault_address}</code>
                    </p>
                )}
                {value.funding_tx_hash && (
                    <p>
                        Funding transaction{" "}
                        {explorer(chainId, value.funding_tx_hash) ? (
                            <a
                                href={explorer(chainId, value.funding_tx_hash)!}
                                target="_blank"
                                rel="noreferrer"
                            >
                                View funding on BaseScan
                            </a>
                        ) : (
                            <code>{value.funding_tx_hash}</code>
                        )}
                    </p>
                )}
                {value.finalization_tx_hash && (
                    <p>
                        Closure transaction{" "}
                        {explorer(chainId, value.finalization_tx_hash) ? (
                            <a
                                href={explorer(chainId, value.finalization_tx_hash)!}
                                target="_blank"
                                rel="noreferrer"
                            >
                                View closure on BaseScan
                            </a>
                        ) : (
                            <code>{value.finalization_tx_hash}</code>
                        )}
                    </p>
                )}
            </div>
        </div>
    );
}
