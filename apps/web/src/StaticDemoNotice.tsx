import { repositoryHref, whitePaperHref } from "./LandingPage";

const prototypeNotice =
    "Prototype only. Fictional issuer and investors. No real securities are offered, no real money is accepted, and testnet tokens have no financial value.";

// Shown at /demo on a static deployment (no VITE_API_URL): the guided demo needs the API, PostgreSQL,
// and a local Anvil chain, so the page explains that instead of rendering panels that cannot load.
export function StaticDemoNotice() {
    return (
        <div className="tepa-landing">
            <header className="tepa-header">
                <div className="tepa-container tepa-header-inner">
                    <a className="tepa-wordmark" href="/" aria-label="TEPA home">
                        TEPA
                    </a>
                </div>
            </header>
            <p className="prototype-notice tepa-public-notice" role="note">
                {prototypeNotice}
            </p>
            <main id="main-content" className="tepa-section tepa-paper">
                <div className="tepa-container tepa-paper-layout">
                    <div>
                        <p className="tepa-section-label">Guided demo</p>
                        <h1 className="tepa-static-demo-title">The guided demo runs on a local chain.</h1>
                    </div>
                    <div>
                        <p>
                            The demo follows one fictional holder through issuance, a blocked transfer, a
                            quarterly distribution, a buyback, and an acquisition settlement. It needs the
                            TEPA API, a PostgreSQL database, and a local Anvil chain with mock test USDC, so
                            it isn&apos;t available on this static site.
                        </p>
                        <ul className="tepa-paper-links">
                            <li>
                                <a href={`${repositoryHref}#run-the-full-demo-locally`}>
                                    Run it yourself: the local demo guide on GitHub
                                </a>
                            </li>
                            <li>
                                <a href={whitePaperHref} type="application/pdf">
                                    Read the recorded results in the white paper draft (PDF)
                                </a>
                            </li>
                            <li>
                                <a href="/">Back to the TEPA overview</a>
                            </li>
                        </ul>
                    </div>
                </div>
            </main>
        </div>
    );
}
