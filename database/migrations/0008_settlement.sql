CREATE TABLE phase4_appraisals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer_id uuid NOT NULL REFERENCES issuers(id),
    state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','APPROVED','CANCELLED')),
    input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
    input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
    pool_usd_minor numeric(78,0) NOT NULL CHECK (pool_usd_minor >= 0),
    indicative_unit_usd_minor numeric(78,0) NOT NULL CHECK (indicative_unit_usd_minor >= 0),
    prepared_by text NOT NULL,
    approved_by text,
    approved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE phase4_cases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer_id uuid NOT NULL REFERENCES issuers(id),
    kind text NOT NULL CHECK (kind IN ('BUYBACK','ACQUISITION')),
    state text NOT NULL CHECK (state IN ('DRAFT','APPROVED','OPEN','TENDER_CLOSED','ALLOCATED','FUNDED','SETTLED','CLOSED','EVIDENCE_REVIEW','SNAPSHOTTED','CLAIMABLE','FINALIZED','RECONCILIATION_REQUIRED','CANCELLED','EXPIRED')),
    version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
    appraisal_id uuid REFERENCES phase4_appraisals(id),
    terms_id uuid NOT NULL REFERENCES prototype_terms(id),
    input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
    input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
    budget_usd_minor numeric(78,0) CHECK (budget_usd_minor IS NULL OR budget_usd_minor > 0),
    binding_unit_price_usd_minor numeric(78,0) CHECK (binding_unit_price_usd_minor IS NULL OR binding_unit_price_usd_minor > 0),
    tender_deadline timestamptz,
    prepared_by text NOT NULL,
    approved_by text,
    approved_at timestamptz,
    record_block numeric(78,0),
    record_block_hash text CHECK (record_block_hash IS NULL OR record_block_hash ~ '^0x[0-9a-fA-F]{64}$'),
    snapshot_hash text CHECK (snapshot_hash IS NULL OR snapshot_hash ~ '^[0-9a-f]{64}$'),
    entitlement_root text CHECK (entitlement_root IS NULL OR entitlement_root ~ '^0x[0-9a-fA-F]{64}$'),
    committed_units integer CHECK (committed_units IS NULL OR committed_units > 0),
    committed_usd_minor numeric(78,0) CHECK (committed_usd_minor IS NULL OR committed_usd_minor > 0),
    vault_address text CHECK (vault_address IS NULL OR vault_address ~ '^0x[0-9a-fA-F]{40}$'),
    funding_tx_hash text CHECK (funding_tx_hash IS NULL OR funding_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    opening_tx_hash text CHECK (opening_tx_hash IS NULL OR opening_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    finalization_tx_hash text CHECK (finalization_tx_hash IS NULL OR finalization_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind='BUYBACK' AND appraisal_id IS NOT NULL AND budget_usd_minor IS NOT NULL AND binding_unit_price_usd_minor IS NOT NULL AND tender_deadline IS NOT NULL)
        OR (kind='ACQUISITION' AND appraisal_id IS NULL))
);
CREATE UNIQUE INDEX one_active_acquisition ON phase4_cases(issuer_id) WHERE kind='ACQUISITION' AND state NOT IN ('CANCELLED');

CREATE TABLE phase4_tenders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES phase4_cases(id),
    holder_id uuid NOT NULL REFERENCES phase2_holders(id),
    wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
    tendered_units integer NOT NULL CHECK (tendered_units > 0),
    holding_units_at_submission integer NOT NULL CHECK (holding_units_at_submission >= tendered_units),
    status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
    submitted_at timestamptz NOT NULL DEFAULT now(),
    cancelled_at timestamptz
);
CREATE UNIQUE INDEX one_active_tender_per_holder ON phase4_tenders(case_id,holder_id) WHERE status='ACTIVE';

CREATE TABLE phase4_allocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES phase4_cases(id),
    holder_id uuid NOT NULL REFERENCES phase2_holders(id),
    tender_id uuid REFERENCES phase4_tenders(id),
    leaf_index integer NOT NULL CHECK (leaf_index >= 0),
    wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
    snapshot_units integer NOT NULL CHECK (snapshot_units > 0),
    accepted_units integer NOT NULL CHECK (accepted_units > 0 AND accepted_units <= snapshot_units),
    amount_usd_minor numeric(78,0) NOT NULL CHECK (amount_usd_minor > 0),
    amount_test_usdc_minor numeric(78,0) NOT NULL CHECK (amount_test_usdc_minor > 0),
    remainder numeric(78,0) NOT NULL CHECK (remainder >= 0),
    proof jsonb NOT NULL CHECK (jsonb_typeof(proof) = 'array'),
    leaf_hash text NOT NULL CHECK (leaf_hash ~ '^0x[0-9a-fA-F]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (case_id, holder_id),
    UNIQUE (case_id, leaf_index)
);
CREATE TRIGGER phase4_allocations_append_only BEFORE UPDATE OR DELETE ON phase4_allocations
FOR EACH ROW EXECUTE FUNCTION reject_financial_evidence_change();

CREATE TABLE phase4_receipts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    allocation_id uuid NOT NULL UNIQUE REFERENCES phase4_allocations(id),
    chain_id integer NOT NULL CHECK (chain_id IN (31337,84532)),
    tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
    log_index integer NOT NULL CHECK (log_index >= 0),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (chain_id,tx_hash,log_index)
);
CREATE TRIGGER phase4_receipts_append_only BEFORE UPDATE OR DELETE ON phase4_receipts
FOR EACH ROW EXECUTE FUNCTION reject_financial_evidence_change();

CREATE TABLE phase4_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_ref text NOT NULL,
    action text NOT NULL,
    idempotency_key uuid NOT NULL,
    request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    resource_version integer NOT NULL CHECK (resource_version >= 0),
    status text NOT NULL CHECK (status IN ('CONFIRMED','PENDING','RECONCILIATION_REQUIRED')),
    response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (actor_ref,action,idempotency_key)
);

CREATE TABLE phase4_chain_steps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES phase4_cases(id),
    step text NOT NULL CHECK (step IN ('VAULT_DEPLOY','ROLE_GRANT','FUND','OPEN','FINALIZE')),
    chain_id integer NOT NULL CHECK (chain_id IN (31337,84532)),
    contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-fA-F]{40}$'),
    tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (case_id,step),
    UNIQUE (chain_id,tx_hash,step)
);
