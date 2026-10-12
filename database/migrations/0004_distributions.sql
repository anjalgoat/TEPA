CREATE TABLE distribution_epochs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer_id uuid NOT NULL REFERENCES issuers(id),
    quarter text NOT NULL CHECK (quarter ~ '^20[0-9]{2}-Q[1-4]$'),
    state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','RECONCILED','REVIEWED','APPROVED','SNAPSHOTTED','FUNDED','CLAIMABLE','CLOSED','RECONCILIATION_REQUIRED','CANCELLED')),
    version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
    import_id uuid NOT NULL REFERENCES financial_imports(id),
    financial_approval_id uuid NOT NULL REFERENCES financial_approvals(id),
    terms_id uuid NOT NULL REFERENCES prototype_terms(id),
    cash_snapshot jsonb NOT NULL CHECK (jsonb_typeof(cash_snapshot) = 'object'),
    cash_snapshot_sha256 text NOT NULL CHECK (cash_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
    pool_usd_minor numeric(78,0) NOT NULL CHECK (pool_usd_minor > 0),
    pool_test_usdc_minor numeric(78,0) NOT NULL CHECK (pool_test_usdc_minor > 0),
    formula_version text NOT NULL,
    prepared_by text NOT NULL,
    reviewed_by text,
    approved_by text,
    approved_at timestamptz,
    record_block numeric(78,0),
    record_block_hash text CHECK (record_block_hash IS NULL OR record_block_hash ~ '^0x[0-9a-fA-F]{64}$'),
    snapshot_hash text CHECK (snapshot_hash IS NULL OR snapshot_hash ~ '^[0-9a-f]{64}$'),
    entitlement_root text CHECK (entitlement_root IS NULL OR entitlement_root ~ '^0x[0-9a-fA-F]{64}$'),
    vault_address text CHECK (vault_address IS NULL OR vault_address ~ '^0x[0-9a-fA-F]{40}$'),
    funding_tx_hash text CHECK (funding_tx_hash IS NULL OR funding_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    opening_tx_hash text CHECK (opening_tx_hash IS NULL OR opening_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer_id, quarter)
);

CREATE TABLE distribution_entitlements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    epoch_id uuid NOT NULL REFERENCES distribution_epochs(id),
    holder_id uuid NOT NULL REFERENCES phase2_holders(id),
    leaf_index integer NOT NULL CHECK (leaf_index >= 0),
    wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
    eligible_units integer NOT NULL CHECK (eligible_units > 0),
    amount_usd_minor numeric(78,0) NOT NULL CHECK (amount_usd_minor >= 0),
    amount_test_usdc_minor numeric(78,0) NOT NULL CHECK (amount_test_usdc_minor >= 0),
    remainder numeric(78,0) NOT NULL CHECK (remainder >= 0),
    rounding_unit_awarded boolean NOT NULL,
    proof jsonb NOT NULL CHECK (jsonb_typeof(proof) = 'array'),
    leaf_hash text NOT NULL CHECK (leaf_hash ~ '^0x[0-9a-fA-F]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (epoch_id, holder_id),
    UNIQUE (epoch_id, leaf_index)
);

CREATE TABLE distribution_claims (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entitlement_id uuid NOT NULL UNIQUE REFERENCES distribution_entitlements(id),
    chain_id integer NOT NULL CHECK (chain_id IN (31337,84532)),
    tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
    log_index integer NOT NULL CHECK (log_index >= 0),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (chain_id, tx_hash, log_index)
);

CREATE TABLE distribution_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_ref text NOT NULL,
    action text NOT NULL,
    idempotency_key uuid NOT NULL,
    request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    resource_version integer NOT NULL CHECK (resource_version >= 0),
    status text NOT NULL CHECK (status IN ('CONFIRMED','PENDING','RECONCILIATION_REQUIRED')),
    response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (actor_ref, action, idempotency_key)
);

CREATE TABLE distribution_chain_steps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    epoch_id uuid NOT NULL REFERENCES distribution_epochs(id),
    step text NOT NULL CHECK (step IN ('VAULT_DEPLOY','FUND','OPEN')),
    chain_id integer NOT NULL CHECK (chain_id IN (31337,84532)),
    contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-fA-F]{40}$'),
    tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (epoch_id, step),
    UNIQUE (chain_id, tx_hash, step)
);

CREATE TRIGGER distribution_entitlements_append_only BEFORE UPDATE OR DELETE ON distribution_entitlements
FOR EACH ROW EXECUTE FUNCTION reject_financial_evidence_change();
CREATE TRIGGER distribution_claims_append_only BEFORE UPDATE OR DELETE ON distribution_claims
FOR EACH ROW EXECUTE FUNCTION reject_financial_evidence_change();
