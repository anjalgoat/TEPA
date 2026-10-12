import type { ReactNode } from "react";

const prototypeNotice =
    "Prototype only. Fictional issuer and investors. No real securities are offered, no real money is accepted, and testnet tokens have no financial value.";

function SectionLabel({ children }: { children: ReactNode }) {
    return <p className="tepa-section-label">{children}</p>;
}

export function LandingPage() {
    return (
        <div className="tepa-landing">
            <a className="skip-link" href="#main-content">
                Skip to content
            </a>
            <header className="tepa-header">
                <div className="tepa-container tepa-header-inner">
                    <a className="tepa-wordmark" href="/" aria-label="TEPA home">
                        TEPA
                    </a>
                    <nav className="tepa-nav" aria-label="Main navigation">
                        <a href="#model">The model</a>
                        <a href="#how-it-works">Economics</a>
                        <a href="#rights">Rights &amp; risks</a>
                    </nav>
                </div>
            </header>

            <p className="prototype-notice tepa-public-notice" role="note">
                {prototypeNotice}
            </p>

            <main id="main-content">
                <section className="tepa-hero" aria-labelledby="tepa-title">
                    <div className="tepa-container tepa-hero-layout">
                        <div className="tepa-hero-copy">
                            <p className="tepa-eyebrow">Tokenized Economic Participation Agreement</p>
                            <h1 id="tepa-title">A defined share of business outcomes.</h1>
                            <p className="tepa-hero-lede">
                                TEPA proposes a way for a business to raise capital by granting holders a
                                contractual share of defined distributable cash and net acquisition proceeds.
                                Founders retain legal shares and voting control. Restricted participation
                                units help record and administer the rights set out in the agreement.
                            </p>
                            <a className="tepa-primary-link" href="#how-it-works">
                                See how participation works
                                <span aria-hidden="true">↓</span>
                            </a>
                            <p className="tepa-prototype-note">
                                Proposed structure. Fictional example. No live investment offering.
                            </p>
                        </div>
                        <div className="tepa-hero-motif" aria-hidden="true">
                            <span className="tepa-motif-line tepa-motif-line-a" />
                            <span className="tepa-motif-line tepa-motif-line-b" />
                            <span className="tepa-motif-join" />
                        </div>
                    </div>
                </section>

                <section id="model" className="tepa-section tepa-exchange" aria-labelledby="model-title">
                    <div className="tepa-container">
                        <SectionLabel>The exchange</SectionLabel>
                        <h2 id="model-title">
                            Capital for the business. Defined participation for the holder.
                        </h2>
                        <div className="tepa-exchange-grid">
                            <div className="tepa-exchange-party">
                                <span className="tepa-party-index">01 / Business</span>
                                <h3>Founder control remains.</h3>
                                <p>
                                    Under the proposed agreement, a business could raise capital while its
                                    founders keep legal shares, voting rights, board control, and operating
                                    authority. The business would take on defined reporting and payment
                                    obligations.
                                </p>
                            </div>
                            <div className="tepa-exchange-party">
                                <span className="tepa-party-index">02 / Holder</span>
                                <h3>The economic claim is defined.</h3>
                                <p>
                                    A holder would receive a contractual economic claim under the agreement,
                                    represented by issuer-specific participation units. The claim depends on
                                    the agreed definitions and the business&apos;s actual outcomes.
                                </p>
                            </div>
                        </div>
                        <div
                            className="tepa-exchange-key"
                            role="group"
                            aria-label="Capital exchanged for a defined economic claim"
                        >
                            <span>Capital</span>
                            <span className="tepa-exchange-rule" aria-hidden="true" />
                            <span>Defined economic claim</span>
                        </div>
                    </div>
                </section>

                <section
                    id="how-it-works"
                    className="tepa-section tepa-economics"
                    aria-labelledby="economics-title"
                >
                    <div className="tepa-container">
                        <SectionLabel>How participation works</SectionLabel>
                        <div className="tepa-section-intro">
                            <h2 id="economics-title">
                                The agreement sets the formula. The business outcome determines the amount.
                            </h2>
                            <p>
                                The proposed terms connect defined cash, eligible holdings, and funded
                                distributions. A period can produce no payment.
                            </p>
                        </div>
                        <ol className="tepa-process">
                            <li>
                                <span className="tepa-process-number">01</span>
                                <h3>Define cash</h3>
                                <p>
                                    The agreement says which receipts, costs, reserves, and deductions count
                                    toward distributable cash.
                                </p>
                            </li>
                            <li>
                                <span className="tepa-process-number">02</span>
                                <h3>Allocate</h3>
                                <p>
                                    An approved amount is allocated to eligible units at a fixed record date.
                                </p>
                            </li>
                            <li>
                                <span className="tepa-process-number">03</span>
                                <h3>Fund and claim</h3>
                                <p>
                                    Eligible holders can claim only after a distribution is funded. The amount
                                    may be zero.
                                </p>
                            </li>
                        </ol>
                        <figure className="tepa-example">
                            <div className="tepa-example-head">
                                <span>Fictional quarterly example</span>
                                <span>Illustrative allocation</span>
                            </div>
                            <div
                                className="tepa-example-equation"
                                role="img"
                                aria-label="$30,000 of defined distributable cash times a 10 percent participation rate equals a $3,000 holder pool. A holder with 100 of 1,000 eligible units has a $300 allocation."
                            >
                                <div>
                                    <span>Defined distributable cash</span>
                                    <strong>$30,000</strong>
                                </div>
                                <span className="tepa-example-operator" aria-hidden="true">
                                    × 10%
                                </span>
                                <div>
                                    <span>Holder pool</span>
                                    <strong>$3,000</strong>
                                </div>
                                <span className="tepa-example-operator" aria-hidden="true">
                                    →
                                </span>
                                <div>
                                    <span>100 of 1,000 units</span>
                                    <strong>$300</strong>
                                </div>
                            </div>
                            <figcaption>
                                The holder has 10% of eligible units. This example is separate from any
                                recorded prototype run. It is not a forecast, yield, or withdrawable balance.
                            </figcaption>
                        </figure>
                        <p className="tepa-acquisition-note">
                            The proposed agreement also covers a share of defined net acquisition proceeds.
                            The deductions and payment priority belong in the full terms.
                        </p>
                    </div>
                </section>

                <section id="rights" className="tepa-section tepa-rights" aria-labelledby="rights-title">
                    <div className="tepa-container">
                        <SectionLabel>Rights and limits</SectionLabel>
                        <h2 id="rights-title">
                            The agreement carries the rights. The token records the holding.
                        </h2>
                        <div className="tepa-rights-grid">
                            <div>
                                <h3>Proposed economic rights</h3>
                                <ul>
                                    <li>A share of defined distributable cash, when available and funded</li>
                                    <li>A share of defined net acquisition proceeds under the agreement</li>
                                    <li>
                                        An optional issuer-funded buyback only if offered under approved terms
                                    </li>
                                </ul>
                            </div>
                            <div>
                                <h3>What a unit does not grant</h3>
                                <ul>
                                    <li>Legal shares, votes, or board control</li>
                                    <li>Guaranteed payments or principal protection</li>
                                    <li>On-demand redemption or free investor-to-investor transfer</li>
                                </ul>
                            </div>
                        </div>
                        <div className="tepa-risk">
                            <h3>Understand the risk</h3>
                            <p>
                                A live investment could lose its full value. Distributions may be zero, the
                                units may be illiquid, and issuer, technical, stablecoin, and regulatory risks
                                apply. The token does not verify financial records or make an agreement
                                enforceable. TEPA is currently a prototype using fictional participants and
                                mock funds.
                            </p>
                        </div>
                        <p className="tepa-regulatory-note">
                            A possible US Regulation Crowdfunding route would require review of the final
                            instrument, an eligible issuer, required disclosures, a registered intermediary,
                            and other launch approvals.
                        </p>
                    </div>
                </section>

                <section id="white-paper" className="tepa-section tepa-paper" aria-labelledby="paper-title">
                    <div className="tepa-container tepa-paper-layout">
                        <div>
                            <SectionLabel>Further reading</SectionLabel>
                            <h2 id="paper-title">Read the full TEPA model.</h2>
                        </div>
                        <div>
                            <p>
                                The white paper will explain the proposed agreement, economic definitions,
                                example calculations, transfer limits, risks, and implementation boundaries,
                                with diagrams and clearly labelled synthetic graphs.
                            </p>
                            <p className="tepa-paper-status">White paper in preparation</p>
                        </div>
                    </div>
                </section>
            </main>

            <footer className="tepa-footer">
                <div className="tepa-container tepa-footer-inner">
                    <div>
                        <strong>TEPA</strong>
                    </div>
                    <nav aria-label="Footer navigation">
                        <a href="#model">The model</a>
                        <a href="#how-it-works">Economics</a>
                        <a href="#rights">Rights &amp; risks</a>
                    </nav>
                </div>
            </footer>
        </div>
    );
}
