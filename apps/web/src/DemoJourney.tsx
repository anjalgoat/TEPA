import type { ReactNode } from "react";
import { prototypeTermsSchema } from "@tepa/domain";
import sampleHolders from "../../../data/fixtures/investors/holders.v1.json";
import sampleTermsFixture from "../../../data/fixtures/issuer/terms.v1.json";
import type { Distributions, Phase2, Overview } from "./api.js";

const sampleTerms = prototypeTermsSchema.parse(sampleTermsFixture);

export const journeySteps = [
    {
        id: "deal",
        label: "Deal",
        title: "One agreement, one clear claim.",
        lead: "A fictional micro-SaaS issuer offers 1,000 restricted units at $100 each: 600 for holder A and 400 for holder B.",
        meaning:
            "Holders get a contractual claim to 10% of defined distributable cash. Units are not legal shares and carry no votes.",
    },
    {
        id: "cash",
        label: "Issuer data",
        title: "The issuer submits its sample financials.",
        lead: "Import 12 months of synthetic records, resolve the three flagged differences, and approve the cash figure.",
        meaning: "No holder is paid from cash that has not been checked and approved first.",
    },
    {
        id: "issuance",
        label: "Issue units",
        title: "Issue 600 units to holder A and 400 to holder B.",
        lead: "Each holder accepts the terms, passes simulated eligibility, links a wallet, and receives restricted units.",
        meaning: "Units count only after the chain balance matches the issuer's holder register.",
    },
    {
        id: "transfer",
        label: "Transfer blocked",
        title: "Holders cannot move units to each other.",
        lead: "Try a transfer from holder A to holder B.",
        meaning:
            "The token contract rejects the transfer with RestrictedTransfer. Units stay with the holder they were issued to.",
    },
    {
        id: "distribution",
        label: "Distribution",
        title: "Both holders receive their share of the cash.",
        lead: "The issuer funds a $1,020 quarterly distribution in mock test USDC on local Anvil.",
        meaning:
            "Holder A claims $612 and holder B claims $408, in proportion to 600 and 400 units. A second claim is rejected.",
    },
    {
        id: "buyback",
        label: "Buyback",
        title: "The issuer offers to buy units back.",
        lead: "A $50,000 window at $200 per unit. Each holder offers 200 units; 125 from each are accepted.",
        meaning:
            "Each holder receives $25,000 in mock test USDC and the 125 sold units are burned. Holder A keeps 475 units and holder B keeps 275.",
    },
] as const;

export type JourneyStep = (typeof journeySteps)[number]["id"];
export type Perspective = "issuer" | "holder-a" | "holder-b";

const holderRef = (perspective: Perspective) =>
    perspective === "holder-b" ? "synthetic-holder-b" : "synthetic-holder-a";
const holderLabel = (perspective: Perspective) => (perspective === "holder-b" ? "Holder B" : "Holder A");
const presetUnits = (perspective: Perspective) =>
    sampleHolders.holders.find((item) => item.holderRef === holderRef(perspective))?.illustrativeUnits ?? 0;

function money(minor: string): string {
    const amount = BigInt(minor);
    const positive = amount < 0n ? -amount : amount;
    return `${amount < 0n ? "−" : ""}$${(positive / 100n).toLocaleString("en-US")}.${(positive % 100n).toString().padStart(2, "0")}`;
}

export function chainName(chainId: number | undefined): string {
    if (chainId === 31337) return "Local Anvil";
    if (chainId === 84532) return "Base Sepolia";
    return chainId ? `Chain ${chainId}` : "Unavailable";
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div>
            <dt>{label}</dt>
            <dd>{children}</dd>
        </div>
    );
}

export function DemoJourney({
    step,
    perspective,
    overview,
    phase2,
    distributions,
    loading,
    detailError,
    actionRoleLabel,
    onStepChange,
    onRefresh,
    canRefresh,
    controls,
}: {
    step: JourneyStep;
    perspective: Perspective;
    overview: Overview | null;
    phase2: Phase2 | null;
    distributions: Distributions | null;
    loading: boolean;
    detailError: string | null;
    actionRoleLabel: string;
    onStepChange: (step: JourneyStep) => void;
    onRefresh: () => void;
    canRefresh: boolean;
    controls: ReactNode;
}) {
    const index = journeySteps.findIndex((item) => item.id === step);
    const current = journeySteps[index]!;
    const terms = phase2?.terms ?? sampleTerms;
    const selected = phase2?.holders.find((item) => item.holderRef === holderRef(perspective));
    const issuanceOperation = phase2?.issuanceOperations.find(
        (item) => item.action === `ISSUE:${holderRef(perspective)}`,
    );
    const issuanceComplete =
        selected?.subscriptionStatus === "RECORDED" &&
        selected.recordedUnits === presetUnits(perspective) &&
        Boolean(selected.issuanceTxHash) &&
        issuanceOperation?.status === "CONFIRMED";
    const latestEpoch = distributions?.epochs[0];
    const entitlement = latestEpoch?.entitlements.find((item) => item.holderRef === holderRef(perspective));
    const evidenceHref = latestEpoch
        ? `/demo/evidence?epoch=${encodeURIComponent(latestEpoch.id)}${perspective === "issuer" ? "" : `&holder=${encodeURIComponent(holderRef(perspective))}`}`
        : null;
    const nav = journeySteps.map((item, itemIndex) => (
        <button
            key={item.id}
            type="button"
            aria-current={step === item.id ? "step" : undefined}
            onClick={() => onStepChange(item.id)}
        >
            <span>{String(itemIndex + 1).padStart(2, "0")}</span>
            {item.label}
        </button>
    ));

    return (
        <>
            <div className="journey-context" aria-label="Current fictional scenario">
                <div>
                    <span>Scenario</span>
                    <strong>{overview?.issuer.displayName ?? "Fictional issuer"}</strong>
                    <small>{overview?.issuer.publicId ?? "Waiting for local run"}</small>
                </div>
                <div>
                    <span>Terms</span>
                    <strong>
                        {phase2?.terms
                            ? `Published v${phase2.terms.version}`
                            : `Sample v${sampleTerms.version}`}
                    </strong>
                    <small>
                        {phase2?.terms
                            ? "Current prototype record"
                            : phase2
                              ? "Not yet published"
                              : "Current status unavailable"}
                    </small>
                </div>
                <div>
                    <span>Preset allocation</span>
                    <strong>
                        {sampleHolders.holders.map((item) => item.illustrativeUnits).join(" / ")} units
                    </strong>
                    <small>Holder A / Holder B · sample only</small>
                </div>
                <div>
                    <span>Environment</span>
                    <strong>{chainName(phase2?.chainId ?? distributions?.chainId)}</strong>
                    <small>
                        {phase2?.chainId || distributions?.chainId
                            ? `Chain ID ${phase2?.chainId ?? distributions?.chainId}`
                            : "No chain status loaded"}
                    </small>
                </div>
            </div>
            <details className="journey-run-refs">
                <summary>Run details</summary>
                <div>
                    <span>Financial import: {overview?.activeImport?.id ?? "not started"}</span>
                    <span>Distribution run: {latestEpoch?.id ?? "not started"}</span>
                    <button type="button" disabled={!canRefresh} onClick={onRefresh}>
                        Refresh run status
                    </button>
                </div>
            </details>
            <div className="journey-mobile-progress">
                Step {index + 1} of {journeySteps.length} · {current.label}
            </div>
            <details className="journey-mobile-nav" key={step}>
                <summary>Show all walkthrough steps</summary>
                <nav aria-label="Walkthrough steps">{nav}</nav>
            </details>
            <div className="journey-layout">
                <nav className="journey-steps" aria-label="Walkthrough steps">
                    {nav}
                </nav>
                <div className="journey-main">
                    <div className="journey-heading">
                        <p>
                            Step {index + 1} of {journeySteps.length} · {current.label}
                        </p>
                        <h1 id="workspace-title" tabIndex={-1}>
                            {current.title}
                        </h1>
                        <p>{current.lead}</p>
                    </div>
                    <div className="journey-stage-content">
                        {loading && <p role="status">Loading current run records…</p>}
                        {detailError && (
                            <p className="journey-data-error" role="alert">
                                {detailError}
                            </p>
                        )}
                        {step === "deal" && (
                            <>
                                <dl className="journey-facts">
                                    <Fact label="Terms record">
                                        {phase2?.terms
                                            ? `Published prototype terms v${phase2.terms.version}`
                                            : "Bundled sample terms; not yet published"}
                                    </Fact>
                                    <Fact label="Illustrative raise">$100,000 · 1,000 units</Fact>
                                    <Fact label="Initial unit price">
                                        {money(terms.initialUnitPriceMinor)}
                                    </Fact>
                                    <Fact label="Participation">
                                        {terms.participationBasisPoints / 100}% of defined distributable cash
                                        and net acquisition proceeds
                                    </Fact>
                                    <Fact label="Holders">Holder A 600 units · Holder B 400 units</Fact>
                                    <Fact label="Rights">
                                        No legal shares, votes or operating control. Ordinary holder transfers
                                        are disabled.
                                    </Fact>
                                </dl>
                                <h2>Sample risk disclosures</h2>
                                <ul className="journey-disclosures">
                                    {terms.disclosures
                                        .filter((item) => !item.startsWith("Prototype only."))
                                        .map((item) => (
                                            <li key={item}>{item}</li>
                                        ))}
                                </ul>
                                <p className="journey-fine-print">
                                    A holder could lose the entire amount paid for units. Eligibility is
                                    simulated; neither contracts nor legal terms have been audited or cleared.
                                </p>
                            </>
                        )}
                        {step === "cash" && (
                            <dl className="journey-facts">
                                <Fact label="Source records">
                                    {overview?.activeImport
                                        ? `Synthetic fixture v${overview.activeImport.fixtureVersion} loaded`
                                        : "No import recorded"}
                                </Fact>
                                <Fact label="Review">
                                    {overview?.approval?.status === "CURRENT"
                                        ? "Approved for current input"
                                        : overview?.review
                                          ? `${overview.cases.filter((item) => item.status === "OPEN").length} open cases`
                                          : "Pending"}
                                </Fact>
                                <Fact label="Formula">
                                    {overview?.review?.formulaVersion ?? "Available after import"}
                                </Fact>
                                <Fact label="2025 defined cash">
                                    {overview?.review
                                        ? money(overview.review.annual.definedDistributableCashMinor)
                                        : "Pending"}
                                </Fact>
                            </dl>
                        )}
                        {step === "issuance" && (
                            <dl className="journey-facts">
                                <Fact label="Terms">
                                    {phase2?.terms
                                        ? `Published v${phase2.terms.version}`
                                        : "Not yet published"}
                                </Fact>
                                <Fact label={`${holderLabel(perspective)} allocation`}>
                                    {presetUnits(perspective)} planned units
                                </Fact>
                                <Fact label="Simulated eligibility">
                                    {selected?.eligibilityStatus.replaceAll("_", " ").toLowerCase() ??
                                        "Pending"}
                                </Fact>
                                <Fact label="Holder register">
                                    {selected ? `${selected.recordedUnits} recorded units` : "Pending"}
                                </Fact>
                                <Fact label="Issuance status">
                                    {issuanceComplete
                                        ? "Complete: chain confirmation and holder register reconciled"
                                        : selected?.subscriptionStatus === "RECONCILIATION_REQUIRED" ||
                                            issuanceOperation?.status === "RECONCILIATION_REQUIRED"
                                          ? "Reconciliation required; issuance is not complete"
                                          : "Pending · not yet reconciled"}
                                </Fact>
                            </dl>
                        )}
                        {step === "transfer" && (
                            <p className="journey-transfer-rule">
                                Units can't be traded or moved between holders. Only the issuer-side registry
                                can mint, recover, or burn them.
                            </p>
                        )}
                        {step === "distribution" && (
                            <>
                                <dl className="journey-facts">
                                    <Fact label="Quarter">{latestEpoch?.quarter ?? "Not prepared"}</Fact>
                                    <Fact label="Pool">
                                        {latestEpoch ? money(latestEpoch.poolUsdMinor) : "Pending"} · local
                                        Anvil mock test USDC
                                    </Fact>
                                    <Fact label="Record block">
                                        {latestEpoch?.recordBlock ?? "Not frozen"}
                                    </Fact>
                                    <Fact label={`${holderLabel(perspective)} share`}>
                                        {entitlement ? money(entitlement.amountUsdMinor) : "Pending"}
                                    </Fact>
                                    <Fact label="Claim">
                                        {entitlement?.claimTxHash
                                            ? "Recorded; duplicate claim blocked by the vault"
                                            : latestEpoch?.state === "CLAIMABLE"
                                              ? "Funded and open"
                                              : "Pending funding and opening"}
                                    </Fact>
                                </dl>
                                {evidenceHref && (
                                    <a className="journey-evidence-link" href={evidenceHref}>
                                        View calculation and chain evidence
                                    </a>
                                )}
                            </>
                        )}
                        {step === "buyback" && (
                            <dl className="journey-facts">
                                <Fact label="Informational estimate">
                                    $200 per unit; non-binding and not withdrawable
                                </Fact>
                                <Fact label="Approved window">
                                    $50,000 budget; binding price applies only when approved and funded
                                </Fact>
                                <Fact label="Holder A">
                                    Offers 200; 125 accepted; $25,000 mock test USDC; keeps 475 units
                                </Fact>
                                <Fact label="Holder B">
                                    Offers 200; 125 accepted; $25,000 mock test USDC; keeps 275 units
                                </Fact>
                                <Fact label="Total supply">1,000 units falls to 750 after the paid burn</Fact>
                            </dl>
                        )}
                    </div>
                    {step !== "deal" && (
                        <section className="journey-inline-actions" aria-label="Current step actions">
                            {controls}
                        </section>
                    )}
                    <div className="journey-navigation">
                        {index > 0 && (
                            <button type="button" onClick={() => onStepChange(journeySteps[index - 1]!.id)}>
                                Back
                            </button>
                        )}
                        {index < journeySteps.length - 1 && (
                            <button
                                className="journey-next"
                                type="button"
                                onClick={() => onStepChange(journeySteps[index + 1]!.id)}
                            >
                                Next step
                            </button>
                        )}
                    </div>
                </div>
                <aside className="journey-meaning" aria-label="What this means">
                    <h2>What this means</h2>
                    <p>{current.meaning}</p>
                    <p>
                        Viewing as: {perspective === "issuer" ? "Issuer" : holderLabel(perspective)}
                        <br />
                        Acting as: {actionRoleLabel}
                    </p>
                </aside>
                <details className="journey-meaning-mobile">
                    <summary>What this means</summary>
                    <p>{current.meaning}</p>
                    <p>
                        Viewing as: {perspective === "issuer" ? "Issuer" : holderLabel(perspective)}
                        <br />
                        Acting as: {actionRoleLabel}
                    </p>
                </details>
            </div>
        </>
    );
}
