import { useEffect, useRef, useState } from "react";

import { EligibilityPanel } from "./EligibilityPanel.js";
import { DistributionPanel } from "./DistributionPanel.js";
import { SettlementPanel } from "./SettlementPanel.js";
import { TransferStep } from "./TransferStep.js";
import { DemoJourney, chainName, journeySteps, type JourneyStep, type Perspective } from "./DemoJourney.js";
import { EvidencePage } from "./EvidencePage.js";
import {
    fetchDistributions,
    fetchOverview,
    fetchPhase2,
    mutate,
    openDemoSession,
    type DemoRole,
    type Distributions,
    type Overview,
    type Phase2,
} from "./api.js";

type Month = NonNullable<Overview["review"]>["periods"][number];
// The API keeps separate issuer-side roles so it can enforce separation of duties.
// The guided demo presents them as one issuer; each action still opens the role it requires.
const personaLabel = (role: DemoRole) =>
    role === "INVESTOR_A" ? "Holder A" : role === "INVESTOR_B" ? "Holder B" : "Issuer";

const lineLabels = {
    receipts: "Eligible processor receipts",
    operating: "Approved operating expenses",
    tax: "Taxes paid or reserved",
    debt: "Required debt service",
    reserve: "Operating reserve contribution",
    excluded: "Excluded or extraordinary items",
} as const;

function usd(amountMinor: string): string {
    const value = BigInt(amountMinor);
    const sign = value < 0n ? "−" : "";
    const positive = value < 0n ? -value : value;
    return (
        sign +
        "$" +
        (positive / 100n).toLocaleString("en-US") +
        "." +
        (positive % 100n).toString().padStart(2, "0")
    );
}

function utc(value: string): string {
    return (
        new Date(value).toLocaleString("en-GB", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "UTC",
        }) + " UTC"
    );
}

function caseTitle(kind: string): string {
    if (kind === "BANK_MISMATCH") return "Bank deposit differs from processor receipt";
    if (kind === "LEDGER_MISMATCH") return "Ledger receipt differs from processor receipt";
    return "Related-party operating expense needs review";
}

function suggestionText(suggestion: string): string {
    if (suggestion === "REVIEW_TIMING")
        return "Suggestion: check deposit timing against the processor record.";
    if (suggestion === "REVIEW_LEDGER")
        return "Suggestion: check the ledger posting against the processor record.";
    return "Suggestion: inspect the related-party expense before acknowledging it.";
}

function MonthEvidence({ month, overview }: { month: Month; overview: Overview }) {
    const review = overview.review;
    if (!review) return null;
    const metric = overview.metrics.find((item) => item.period === month.period);
    const sourceFor = (sourceRef: string) => overview.sourceRows.find((row) => row.sourceRef === sourceRef);
    return (
        <section className="evidence" aria-labelledby="evidence-heading">
            <div className="section-heading">
                <div>
                    <p className="section-index">03 / Source trail</p>
                    <h2 id="evidence-heading">{month.period} · Input lines</h2>
                </div>
                <p>Select another month above to inspect its source references and hashes.</p>
            </div>
            <div className="evidence-layout">
                <div className="cash-lines">
                    {(Object.keys(lineLabels) as Array<keyof typeof lineLabels>).map((key) => {
                        const line = month.lines[key];
                        const source = sourceFor(line.sourceRefs[0] ?? "");
                        return (
                            <div className="cash-line" key={key}>
                                <div>
                                    <strong>{lineLabels[key]}</strong>
                                    <span>
                                        {source?.sourceRef ?? "Source missing"} ·{" "}
                                        {source?.evidenceRef ?? "Evidence missing"} · SHA-256{" "}
                                        {source?.rowSha256 ?? "missing"}
                                    </span>
                                </div>
                                <b>
                                    {key === "receipts" ? "" : "−"}
                                    {usd(line.amountMinor)}
                                </b>
                            </div>
                        );
                    })}
                    <div className="cash-line total">
                        <div>
                            <strong>Defined distributable cash</strong>
                            <span>{review.formulaVersion}</span>
                        </div>
                        <b>{usd(month.definedDistributableCashMinor)}</b>
                    </div>
                </div>
                <div className="source-side">
                    <h3>Matching suggestions</h3>
                    {review.matches
                        .filter((match) => match.period === month.period)
                        .map((match) => {
                            const compared = sourceFor(match.comparedRef);
                            return (
                                <div className="match" key={match.comparedRef}>
                                    <strong>
                                        {match.sourceSystem === "BANK" ? "Bank deposit" : "Ledger receipt"}:{" "}
                                        {match.status === "EXACT" ? "exact match" : "difference to review"}
                                    </strong>
                                    <span>
                                        {match.processorRef} ↔ {match.comparedRef}
                                    </span>
                                    <span>Difference from processor: {usd(match.deltaMinor)}</span>
                                    <span>
                                        Compared amount:{" "}
                                        {compared ? usd(compared.amountMinor) : "Source missing"}
                                    </span>
                                    <span>
                                        {compared?.evidenceRef ?? "Evidence missing"} · SHA-256{" "}
                                        {compared?.rowSha256 ?? "missing"}
                                    </span>
                                </div>
                            );
                        })}
                    <h3>Customer context</h3>
                    {metric && (
                        <div className="metric">
                            <span>
                                {metric.activeCustomers} active customers · ARR {usd(metric.arrMinor)} · churn{" "}
                                {metric.churnBasisPoints / 100}%
                            </span>
                            <small>
                                {metric.sourceRef} · {metric.evidenceRef} · SHA-256 {metric.rowSha256}
                            </small>
                            <p>Context only; ARR and customer counts do not enter the cash formula.</p>
                        </div>
                    )}
                </div>
            </div>
        </section>
    );
}

export function App() {
    const query = new URLSearchParams(window.location.search);
    const isEvidencePage = window.location.pathname === "/demo/evidence";
    const requestedStep = journeySteps.find((item) => item.id === query.get("step"))?.id;
    const requestedHolder = query.get("holder");
    const initialPerspective: Perspective =
        requestedHolder === "synthetic-holder-b"
            ? "holder-b"
            : requestedHolder === "synthetic-holder-a"
              ? "holder-a"
              : "issuer";
    const [role] = useState<DemoRole>("ISSUER_PREPARER");
    const [step, setStep] = useState<JourneyStep>(requestedStep ?? "deal");
    const [actingRole, setActingRole] = useState<DemoRole>("ISSUER_PREPARER");
    const [perspective, setPerspective] = useState<Perspective>(initialPerspective);
    const [reload, setReload] = useState(0);
    const [token, setToken] = useState<string | null>(null);
    const [overview, setOverview] = useState<Overview | null>(null);
    const [phase2, setPhase2] = useState<Phase2 | null>(null);
    const [distributions, setDistributions] = useState<Distributions | null>(null);
    const [detailError, setDetailError] = useState<string | null>(null);
    const [selectedPeriod, setSelectedPeriod] = useState("2025-01");
    const [caseReasons, setCaseReasons] = useState<Record<string, string>>({});
    const [approvalReason, setApprovalReason] = useState("");
    const [loading, setLoading] = useState(true);
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const keys = useRef(new Map<string, string>());
    const sessionGeneration = useRef(0);
    const errorRef = useRef<HTMLDivElement>(null);

    // The error box sits above the step; bring it into view so a refused action is never silent.
    useEffect(() => {
        if (error) errorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, [error]);

    useEffect(() => {
        let active = true;
        const generation = ++sessionGeneration.current;
        setLoading(true);
        setToken(null);
        setError(null);
        setOverview(null);
        setPhase2(null);
        setDistributions(null);
        setDetailError(null);
        async function start() {
            try {
                const sessionToken = await openDemoSession(role);
                const data = await fetchOverview(sessionToken);
                const [termsResult, distributionResult] = await Promise.allSettled([
                    fetchPhase2(sessionToken),
                    fetchDistributions(sessionToken),
                ]);
                if (active && sessionGeneration.current === generation) {
                    setToken(sessionToken);
                    setOverview(data);
                    setPhase2(termsResult.status === "fulfilled" ? termsResult.value : null);
                    setDistributions(
                        distributionResult.status === "fulfilled" ? distributionResult.value : null,
                    );
                    setDetailError(
                        termsResult.status === "rejected" || distributionResult.status === "rejected"
                            ? "Some current run records could not be loaded. Reload before relying on their status."
                            : null,
                    );
                }
            } catch (cause) {
                if (active && sessionGeneration.current === generation)
                    setError(cause instanceof Error ? cause.message : "Could not open the issuer workspace.");
            } finally {
                if (active && sessionGeneration.current === generation) setLoading(false);
            }
        }
        void start();
        return () => {
            active = false;
        };
    }, [role, reload]);

    async function refresh(sessionToken: string) {
        const generation = sessionGeneration.current;
        const data = await fetchOverview(sessionToken);
        const [termsResult, distributionResult] = await Promise.allSettled([
            fetchPhase2(sessionToken),
            fetchDistributions(sessionToken),
        ]);
        if (sessionGeneration.current !== generation) return;
        setOverview(data);
        setPhase2(termsResult.status === "fulfilled" ? termsResult.value : null);
        setDistributions(distributionResult.status === "fulfilled" ? distributionResult.value : null);
        setDetailError(
            termsResult.status === "rejected" || distributionResult.status === "rejected"
                ? "Some current run records could not be loaded. Reload before relying on their status."
                : null,
        );
    }

    useEffect(() => {
        if (!token || !phase2?.issuanceOperations.some((item) => item.status === "PENDING")) return;
        let inFlight = false;
        const interval = window.setInterval(() => {
            if (inFlight) return;
            inFlight = true;
            void refresh(token)
                .catch(() => setDetailError("Issuance status could not be refreshed. Try again."))
                .finally(() => {
                    inFlight = false;
                });
        }, 4000);
        return () => window.clearInterval(interval);
    }, [token, phase2, role]);

    async function sessionForRole(requiredRole: DemoRole): Promise<string> {
        const sessionToken = await openDemoSession(requiredRole);
        setActingRole(requiredRole);
        return sessionToken;
    }

    async function act(
        action: string,
        path: string,
        body: unknown,
        reason: string,
        requiredRole: DemoRole = "ISSUER_PREPARER",
    ) {
        if (!token || !overview) return;
        if (reason.trim().length < 8) {
            setError("Enter a reason of at least 8 characters before recording this decision.");
            return;
        }
        const operationKey = action + ":" + overview.issuer.version + ":" + reason.trim();
        const idempotencyKey = keys.current.get(operationKey) ?? crypto.randomUUID();
        keys.current.set(operationKey, idempotencyKey);
        setPending(action);
        setError(null);
        try {
            await mutate(
                await sessionForRole(requiredRole),
                path,
                body,
                overview.issuer.version,
                reason.trim(),
                idempotencyKey,
            );
            keys.current.delete(operationKey);
            await refresh(token);
        } catch (cause) {
            setError(
                cause instanceof Error
                    ? cause.message
                    : "The action could not be recorded. Refresh and retry.",
            );
        } finally {
            setPending(null);
        }
    }

    const review = overview?.review;
    const month = review?.periods.find((item) => item.period === selectedPeriod) ?? review?.periods[0];
    const openCases = overview?.cases.filter((item) => item.status === "OPEN") ?? [];
    const workflowStage = step === "issuance" ? "issuance" : null;
    const selectedHolderRef = perspective === "holder-b" ? "synthetic-holder-b" : "synthetic-holder-a";
    function selectStep(nextStep: JourneyStep) {
        setStep(nextStep);
        const index = journeySteps.findIndex((item) => item.id === nextStep);
        if (index <= 1) setPerspective("issuer");
        if (index >= 2) setPerspective((current) => (current === "issuer" ? "holder-a" : current));
        requestAnimationFrame(() => document.getElementById("workspace-title")?.focus());
    }

    return (
        <div className="demo-app">
            <a className="skip-link" href="#workspace-content">
                Skip to workspace
            </a>
            <header className="site-header">
                <div className="header-inner">
                    <div className="brand demo-brand">
                        <strong>TEPA</strong>
                        <span>Guided demo</span>
                    </div>
                    <a className="demo-home-link" href="/">
                        About TEPA
                    </a>
                    <span className="acting-role" role="status">
                        Acting as: {personaLabel(actingRole)}
                    </span>
                    <label className="role-control" htmlFor="demo-perspective">
                        <span>View as</span>
                        <select
                            id="demo-perspective"
                            value={perspective}
                            onChange={(event) => setPerspective(event.target.value as Perspective)}
                        >
                            <option value="issuer">Issuer</option>
                            <option value="holder-a">Holder A</option>
                            <option value="holder-b">Holder B</option>
                        </select>
                    </label>
                </div>
            </header>
            <div className="prototype-notice demo-prototype-notice" role="note">
                <span>
                    Prototype only. Fictional issuer and investors. No real securities are offered, no real
                    money is accepted, and testnet tokens have no financial value.
                </span>
                <strong>Environment: {chainName(phase2?.chainId ?? distributions?.chainId)}</strong>
            </div>
            <main id="workspace-content" className="workspace">
                {error && (
                    <div className="error-message" role="alert" ref={errorRef}>
                        <strong>Action needed</strong>
                        <p>{error}</p>
                        <button type="button" onClick={() => setReload((value) => value + 1)}>
                            Reload workspace
                        </button>
                    </div>
                )}
                {loading && (
                    <p className="state-message" role="status">
                        Loading the fictional workspace…
                    </p>
                )}
                {!loading && !overview && !error && (
                    <p className="state-message">
                        The workspace is unavailable. Check that the API and PostgreSQL are running, then
                        reload.
                    </p>
                )}

                {isEvidencePage ? (
                    <EvidencePage
                        overview={overview}
                        phase2={phase2}
                        distributions={distributions}
                        requestedEpochId={query.get("epoch")}
                        requestedHolderRef={requestedHolder}
                        loading={loading}
                        detailError={detailError}
                        canRefresh={Boolean(token) && !loading}
                        onRefresh={() => {
                            if (!token) return;
                            const generation = sessionGeneration.current;
                            void refresh(token).catch(() => {
                                if (sessionGeneration.current === generation)
                                    setDetailError("Current run evidence could not be refreshed. Try again.");
                            });
                        }}
                    />
                ) : (
                    <DemoJourney
                        step={step}
                        perspective={perspective}
                        overview={overview}
                        phase2={phase2}
                        distributions={distributions}
                        loading={loading}
                        detailError={detailError}
                        actionRoleLabel={personaLabel(actingRole)}
                        onStepChange={selectStep}
                        canRefresh={Boolean(token) && !loading}
                        onRefresh={() => {
                            if (!token) return;
                            const generation = sessionGeneration.current;
                            void refresh(token).catch(() => {
                                if (sessionGeneration.current === generation)
                                    setDetailError("Current run status could not be refreshed. Try again.");
                            });
                        }}
                        controls={
                            <>
                                {step === "cash" && !loading && overview && !overview.activeImport && (
                                    <section className="empty-state" aria-labelledby="empty-title">
                                        <p className="section-index">01 / Source import</p>
                                        <h2 id="empty-title">No financial import yet</h2>
                                        <p>
                                            Load the first fictional processor, bank, ledger, expense, debt,
                                            and customer-metric rows to begin the review.
                                        </p>
                                        <button
                                            className="primary-action"
                                            type="button"
                                            disabled={pending !== null}
                                            onClick={() =>
                                                void act(
                                                    "import-v1",
                                                    "/financial-imports",
                                                    { fixtureVersion: 1 },
                                                    "Load the first fictional financial source set",
                                                )
                                            }
                                        >
                                            {pending ? "Importing records…" : "Import fictional records"}
                                        </button>
                                    </section>
                                )}

                                {step === "cash" && !loading && overview?.activeImport && review && (
                                    <>
                                        <section className="review-lead" aria-labelledby="review-heading">
                                            <div>
                                                <p className="section-index">01 / Review status</p>
                                                <h2 id="review-heading">
                                                    {openCases.length
                                                        ? String(openCases.length) +
                                                          " flagged items need a decision"
                                                        : overview.approval?.status === "CURRENT"
                                                          ? "Cash preview approved"
                                                          : "Ready for finance approval"}
                                                </h2>
                                                <p>
                                                    Fixture v{overview.activeImport.fixtureVersion} · imported
                                                    by {overview.activeImport.importedBy} ·{" "}
                                                    {utc(overview.activeImport.importedAt)}
                                                </p>
                                                {overview.approval?.status ===
                                                    "INVALIDATED_BY_NEW_IMPORT" && (
                                                    <p className="stale-notice">
                                                        Approval for fixture v
                                                        {overview.approval.fixtureVersion} is invalidated by
                                                        this revised input. Review the differences and approve
                                                        this version separately.
                                                    </p>
                                                )}
                                            </div>
                                            <div className="decision-count">
                                                <strong>{openCases.length}</strong>
                                                <span>open review cases</span>
                                            </div>
                                        </section>

                                        <section className="preview" aria-labelledby="preview-heading">
                                            <div className="section-heading">
                                                <div>
                                                    <p className="section-index">02 / Calculation</p>
                                                    <h2 id="preview-heading">Distributable cash preview</h2>
                                                </div>
                                                <p>
                                                    Sample only. This is not a funded distribution or a holder
                                                    entitlement.
                                                </p>
                                            </div>
                                            <div className="annual-summary">
                                                <div>
                                                    <span>2025 defined distributable cash</span>
                                                    <strong>
                                                        {usd(review.annual.definedDistributableCashMinor)}
                                                    </strong>
                                                    <small>Sum of 12 monthly cash calculations</small>
                                                </div>
                                                <div>
                                                    <span>Illustrative 10% participation pool</span>
                                                    <strong>
                                                        {usd(review.annual.distributionPoolMinor)}
                                                    </strong>
                                                    <small>Sum of 12 monthly floor-rounded previews</small>
                                                </div>
                                            </div>
                                            <details className="review-detail">
                                                <summary>
                                                    Inspect monthly calculations and source records
                                                </summary>
                                                <div
                                                    className="period-list"
                                                    aria-label="Monthly cash calculations"
                                                >
                                                    <div className="period-list-head">
                                                        <span>Period</span>
                                                        <span>Receipts</span>
                                                        <span>Defined cash</span>
                                                        <span>Pool preview</span>
                                                    </div>
                                                    {review.periods.map((item) => (
                                                        <button
                                                            className={
                                                                "period-row " +
                                                                (month?.period === item.period
                                                                    ? "selected"
                                                                    : "")
                                                            }
                                                            type="button"
                                                            key={item.period}
                                                            aria-pressed={month?.period === item.period}
                                                            onClick={() => setSelectedPeriod(item.period)}
                                                        >
                                                            <span>{item.period}</span>
                                                            <span data-label="Receipts">
                                                                {usd(item.lines.receipts.amountMinor)}
                                                            </span>
                                                            <span data-label="Defined cash">
                                                                {usd(item.definedDistributableCashMinor)}
                                                            </span>
                                                            <span data-label="Pool preview">
                                                                {usd(item.distributionPoolMinor)}
                                                            </span>
                                                        </button>
                                                    ))}
                                                </div>
                                                {month && <MonthEvidence month={month} overview={overview} />}
                                            </details>
                                        </section>

                                        <section className="review-cases" aria-labelledby="cases-heading">
                                            <div className="section-heading">
                                                <div>
                                                    <p className="section-index">04 / Reviewer decisions</p>
                                                    <h2 id="cases-heading">Flagged source differences</h2>
                                                </div>
                                                <p>
                                                    Suggestions do not change amounts. A finance reviewer
                                                    records a reason for each decision.
                                                </p>
                                            </div>
                                            <div className="case-list">
                                                {overview.cases.map((item) => (
                                                    <article className="case-item" key={item.caseKey}>
                                                        <div className="case-summary">
                                                            <span>
                                                                {item.period} ·{" "}
                                                                {item.status === "OPEN" ? "Open" : "Reviewed"}
                                                            </span>
                                                            <h3>{caseTitle(item.kind)}</h3>
                                                            <p>
                                                                {item.sourceRefs.join(" ↔ ")}
                                                                {item.kind !== "RELATED_PARTY"
                                                                    ? " · difference " + usd(item.deltaMinor)
                                                                    : ""}
                                                            </p>
                                                            <p>{suggestionText(item.suggestion)}</p>
                                                            {item.status === "RESOLVED" && (
                                                                <p>
                                                                    Decision:{" "}
                                                                    {item.resolutionCode
                                                                        ?.replaceAll("_", " ")
                                                                        .toLowerCase()}{" "}
                                                                    · {item.reason} · {item.reviewedBy}
                                                                </p>
                                                            )}
                                                        </div>
                                                        {item.status === "OPEN" && (
                                                            <div className="case-action">
                                                                <label htmlFor={"reason-" + item.caseKey}>
                                                                    Reason for decision (at least 8
                                                                    characters)
                                                                </label>
                                                                <textarea
                                                                    id={"reason-" + item.caseKey}
                                                                    value={caseReasons[item.caseKey] ?? ""}
                                                                    onChange={(event) =>
                                                                        setCaseReasons((previous) => ({
                                                                            ...previous,
                                                                            [item.caseKey]:
                                                                                event.target.value,
                                                                        }))
                                                                    }
                                                                    placeholder="Explain how this fictional difference was reviewed"
                                                                    rows={3}
                                                                />
                                                                <button
                                                                    type="button"
                                                                    disabled={pending !== null}
                                                                    onClick={() =>
                                                                        void act(
                                                                            item.caseKey,
                                                                            "/reconciliations/" +
                                                                                encodeURIComponent(
                                                                                    item.caseKey,
                                                                                ) +
                                                                                "/resolve",
                                                                            {
                                                                                resolutionCode:
                                                                                    item.kind ===
                                                                                    "RELATED_PARTY"
                                                                                        ? "ACKNOWLEDGE_RELATED_PARTY"
                                                                                        : "ACCEPT_PROCESSOR",
                                                                            },
                                                                            caseReasons[item.caseKey] ?? "",
                                                                            "FINANCE_REVIEWER",
                                                                        )
                                                                    }
                                                                >
                                                                    {pending === item.caseKey
                                                                        ? "Recording…"
                                                                        : item.kind === "RELATED_PARTY"
                                                                          ? "Acknowledge expense"
                                                                          : "Use processor amount"}
                                                                </button>
                                                            </div>
                                                        )}
                                                    </article>
                                                ))}
                                            </div>
                                            {!openCases.length && overview.approval?.status !== "CURRENT" && (
                                                <div className="approval-action">
                                                    <label htmlFor="approval-reason">
                                                        Approval reason (at least 8 characters)
                                                    </label>
                                                    <textarea
                                                        id="approval-reason"
                                                        value={approvalReason}
                                                        onChange={(event) =>
                                                            setApprovalReason(event.target.value)
                                                        }
                                                        placeholder="State why this fictional cash preview is ready"
                                                        rows={3}
                                                    />
                                                    <button
                                                        className="primary-action"
                                                        type="button"
                                                        disabled={pending !== null}
                                                        onClick={() =>
                                                            void act(
                                                                "approve",
                                                                "/reconciliations/approve",
                                                                {},
                                                                approvalReason,
                                                                "FINANCE_REVIEWER",
                                                            )
                                                        }
                                                    >
                                                        {pending === "approve"
                                                            ? "Recording approval…"
                                                            : "Approve this preview"}
                                                    </button>
                                                </div>
                                            )}
                                            {overview.approval?.status === "CURRENT" && (
                                                <p className="approval-record">
                                                    Approved by {overview.approval.approvedBy} at{" "}
                                                    {utc(overview.approval.approvedAt)} for fixture v
                                                    {overview.approval.fixtureVersion}. This approval covers
                                                    only the displayed synthetic inputs.
                                                </p>
                                            )}
                                        </section>

                                        <section className="provenance" aria-labelledby="provenance-heading">
                                            <details className="review-detail">
                                                <summary id="provenance-heading">
                                                    Inspect import version and source hash
                                                </summary>
                                                <p>
                                                    Each amount links to a synthetic source reference and a
                                                    SHA-256 row hash. The full imported file is bound by this
                                                    hash:
                                                </p>
                                                <code>{overview.activeImport.inputSha256}</code>
                                            </details>
                                            {overview.activeImport.fixtureVersion === 1 &&
                                                overview.approval?.status === "CURRENT" && (
                                                    <button
                                                        type="button"
                                                        disabled={pending !== null}
                                                        onClick={() =>
                                                            void act(
                                                                "import-v2",
                                                                "/financial-imports",
                                                                { fixtureVersion: 2 },
                                                                "Load revised fictional operating expense evidence",
                                                            )
                                                        }
                                                    >
                                                        {pending === "import-v2"
                                                            ? "Loading revision…"
                                                            : "Load revised expense input"}
                                                    </button>
                                                )}
                                        </section>
                                    </>
                                )}
                                {workflowStage && !loading && overview && token && (
                                    <EligibilityPanel
                                        token={token}
                                        role={role}
                                        issuerVersion={overview?.issuer.version ?? null}
                                        onChange={() => (token ? refresh(token) : Promise.resolve())}
                                        stage={workflowStage}
                                        selectedHolderRef={selectedHolderRef}
                                        currentRun={phase2}
                                        sessionForRole={sessionForRole}
                                    />
                                )}
                                {step === "transfer" && !loading && <TransferStep phase2={phase2} />}
                                {step === "distribution" && !loading && overview && token && (
                                    <DistributionPanel
                                        token={token}
                                        role={role}
                                        issuerVersion={overview?.issuer.version ?? null}
                                        onChange={() => (token ? refresh(token) : Promise.resolve())}
                                        currentRun={distributions}
                                        sessionForRole={sessionForRole}
                                    />
                                )}
                                {step === "buyback" && !loading && overview && token && (
                                    <SettlementPanel
                                        token={token}
                                        role={role}
                                        mode="buyback"
                                        selectedHolderRef={selectedHolderRef}
                                        sessionForRole={sessionForRole}
                                        issuerVersion={overview.issuer.version}
                                        onChange={() => refresh(token)}
                                    />
                                )}
                            </>
                        }
                    />
                )}
            </main>
        </div>
    );
}
