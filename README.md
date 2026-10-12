# TEPA: Tokenized Economic Participation Agreement

> **Prototype notice.** Fictional issuer, fictional holders, synthetic financials, simulated eligibility, and mock test USDC. This is not a live offering, legal advice, or a production financial system. The contracts have not been audited.

White paper: [`white-paper.pdf`](white-paper.pdf)

## The problem

A founder with recurring revenue may want growth capital without selling shares or taking on a fixed-repayment loan. A private investor may want a defined, traceable claim on the cash the business actually produces.

TEPA is an agreement that gives holders a **contractual share of defined distributable cash and net acquisition proceeds**. Founders keep their legal shares, votes, and control. **Restricted participation units** record and service the claim on-chain. Holders cannot transfer them to each other, so the units can't turn into a freely traded token.

## What works today

One fictional US micro-SaaS issuer and two fictional holders go through the full lifecycle on local Anvil (chain 31337) with a PostgreSQL database:

| Step | What happens |
| --- | --- |
| Reconciliation | Sample financials are imported and reviewed. Approval is refused while 3 flagged cases are open, and the preparer cannot resolve them alone. The annual pool is 624,000 cents. |
| Eligibility and issuance | Simulated identity and sanctions checks, plus a signed wallet-binding challenge. Then 600 units go to holder A and 400 to holder B, reconciled against the holder register (supply 1,000). |
| Transfer restrictions | `transfer`, `transferFrom`, and `approve` revert with `RestrictedTransfer`. A mint by a holder reverts with `Unauthorized`. |
| Quarterly distribution | Balances are frozen at one block, cents are allocated exactly, and a Merkle root is committed to a funded vault. Holders claim 612 / 408 mock USDC. A stolen proof reverts with `InvalidProof` and a second claim with `AlreadyClaimed`. |
| Issuer-funded buyback | Against a $50,000 budget, two 200-unit tenders are filled 125 + 125 by deterministic oversubscription. Paid units are burned. |
| Acquisition | An $80,000 pool is paid over the remaining 750 units. Supply ends at zero, the token is marked terminal, and new distributions and mints are refused. |
| Audit | Every chain-backed action is recorded as an attributable audit event with chain references. |

On 2026-10-12, `npm run demo:rehearse -- --strict-audit` ran this path end to end on a freshly reset scene and passed all 47 checks.

## Architecture

```
apps/web            React + Vite: public explainer (/), guided judge demo (/demo), evidence page
apps/api            Express API: roles, validation, state transitions, audit log, chain workers
packages/domain     Exact money types (integer minor units), cash/distribution/settlement formulas
database/migrations PostgreSQL schema with integrity constraints (checksummed, forward-only)
data/fixtures       Versioned fictional issuer, financial, holder, and settlement inputs
smart-contract      Foundry: TepaToken (restricted, ERC-3643 style), DistributionVault,
                    SettlementVault, mock TestUsdc, deployment script, tests
scripts             rehearse-demo.mjs: end-to-end reviewer-path replay against the API and chain
```

Each layer has one job:

- `packages/domain` does all financial math, deterministically.
- The API authorizes actions and records them.
- PostgreSQL holds the agreement, approvals, and evidence.
- The chain holds restricted balances and settlement receipts.
- Workers reconcile the database with the chain. A transaction hash alone does not count as settlement, and failed cross-system actions stay visible.

## Verify the code (about 2 minutes)

Requires Node.js 24+ and [Foundry](https://book.getfoundry.sh/).

```sh
npm ci
npm run build -w @tepa/domain
npm run lint && npm run typecheck && npm run format:check
npm test                 # domain, API, and web unit tests
npm run fixtures:check   # fixture integrity
npm run build
npm run test:contracts   # Foundry tests for token, distribution, settlement
```

The database/Anvil integration suite needs PostgreSQL 16+ and a **disposable** database, because it truncates the target:

```sh
createdb tepa_test
forge build --root smart-contract
TEST_DATABASE_URL=postgresql://localhost:5432/tepa_test npm run test:db -w @tepa/api
```

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the same checks against a fresh PostgreSQL service.

## Run the full demo locally

Requires Node.js 24+, PostgreSQL 16+, and Foundry (`anvil`, `forge`, `cast`).

**1. Local environment.** Fill in local-only Anvil keys and addresses. Leave the contract addresses empty for now. Export the file in every terminal you use.

```sh
cp apps/api/.env.anvil.example apps/api/.env.anvil
set -a; . apps/api/.env.anvil; set +a
```

**2. Chain and database.**

```sh
anvil --host 127.0.0.1 --port 8545 --chain-id 31337 --silent   # separate terminal
createdb -h 127.0.0.1 tepa_hackathon
npm ci && npm run build -w @tepa/domain && forge build --root smart-contract
TEPA_TOKEN_ADDRESS= TEST_USDC_ADDRESS= TEPA_TOKEN_CODE_HASH= TEST_USDC_CODE_HASH= \
  npm run demo:reset -- --confirm=tepa_hackathon
```

`demo:reset` refuses remote databases, remote RPCs, and any chain other than 31337. It seeds fictional fixture v1, terms v1, and the planned 600/400 register.

**3. Deploy local contracts and mint mock USDC.**

```sh
npm run demo:deploy-local
```

Copy the four printed `TEPA_TOKEN_*` / `TEST_USDC_*` lines into `.env.anvil` and export it again. No private key is printed.

**4. Start the scene** (each in an exported terminal):

```sh
(cd apps/api && node --import tsx src/server.ts)
npm run demo:work
npm run dev -w @tepa/web
```

Open `http://localhost:5173/demo` for the guided eight-step walkthrough. Add chain 31337 at `http://127.0.0.1:8545` to a browser wallet, using two test-only accounts as holders A and B.

**5. Or replay everything in one command** (after a fresh reset and deploy):

```sh
export DEMO_HOLDER_A_PRIVATE_KEY=... DEMO_HOLDER_B_PRIVATE_KEY=...   # local Anvil test keys only
npm run demo:rehearse -- --strict-audit
```

The script signs holder actions with local test keys in place of a wallet extension. It is an API and chain check, not a browser rehearsal. A full run finalizes the scene, so reset again before presenting.

## Public on-chain evidence: Base Sepolia (issuance only)

The same restricted token was deployed and source-verified on Base Sepolia (chain 84532), and 600/400 units were issued there. **No distribution, buyback, or acquisition ran on Base Sepolia**; those ran only locally with mock USDC. The full record is in [`smart-contract/deployments/base-sepolia.json`](smart-contract/deployments/base-sepolia.json).

| Evidence | Link |
| --- | --- |
| Token `0xD4685cF0aeC08A86C5aB9Dc86cd177FC4775B663` (verified source) | [BaseScan](https://sepolia.basescan.org/address/0xD4685cF0aeC08A86C5aB9Dc86cd177FC4775B663#code) |
| Deployment transaction | [BaseScan](https://sepolia.basescan.org/tx/0x0b2a43e2a7b2b2f51b487d642a6c6b67da749c539021ff800e186c22ec8f2f5f) |
| Holder A issuance, 600 units | [BaseScan](https://sepolia.basescan.org/tx/0xb02eb5880af8ff098d6e02ceb6709f6334c29ee1ed8e81ec45cfdd3148521391) |
| Holder B issuance, 400 units | [BaseScan](https://sepolia.basescan.org/tx/0xdc3d8566c903d036d0ac1bf847a2560d9053cedff7343e7a2113c5b23c56ac39) |

Read-only `transfer`, `transferFrom`, and `approve` calls against the deployed token revert with `RestrictedTransfer()` (`0x3894bf92`).

## Known limitations

- Acquisition finalization requires every remaining holder to settle. A holder who never settles blocks closure.
- Funds that are never claimed or are blocked can't be swept from a vault yet; that policy is an open legal question.
- In the demo, one test key holds every local contract role, and one Base Sepolia wallet holds the admin, compliance, issuer-agent, pauser, and recovery roles.
- The contracts are custom prototypes and have not been audited.
- Legal terms are unresolved and need counsel, including the cash definitions, valuation method, transfer exceptions, and offering route. The [white paper](white-paper.pdf) has not had legal, accounting, or technical review.
- Role selection in the UI issues simulated local sessions, not production authentication.
