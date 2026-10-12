CREATE TABLE prototype_terms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer_id uuid NOT NULL REFERENCES issuers(id),
    version integer NOT NULL CHECK (version > 0),
    terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    published_by text NOT NULL,
    published_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer_id, version)
);

CREATE TABLE phase2_holders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer_id uuid NOT NULL REFERENCES issuers(id),
    holder_ref text NOT NULL CHECK (holder_ref IN ('synthetic-holder-a', 'synthetic-holder-b')),
    subject_hash text NOT NULL CHECK (subject_hash ~ '^0x[0-9a-f]{64}$'),
    planned_units integer NOT NULL CHECK (planned_units > 0 AND planned_units <= 1000),
    terms_id uuid REFERENCES prototype_terms(id),
    terms_acknowledged_at timestamptz,
    eligibility_status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (eligibility_status IN ('NOT_STARTED', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED')),
    eligibility_decision_id uuid,
    eligibility_evidence_ref text,
    eligibility_expires_at timestamptz,
    jurisdiction text,
    wallet_address text UNIQUE CHECK (wallet_address IS NULL OR wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
    wallet_bound_at timestamptz,
    subscription_status text NOT NULL DEFAULT 'DRAFT' CHECK (subscription_status IN ('DRAFT', 'ACKNOWLEDGED', 'ELIGIBLE', 'COMMITTED_SIMULATION', 'ALLOCATED', 'MINTED', 'RECORDED', 'RECONCILIATION_REQUIRED', 'REJECTED', 'EXPIRED')),
    allocation_case_id uuid,
    issuance_tx_hash text CHECK (issuance_tx_hash IS NULL OR issuance_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    recorded_units integer NOT NULL DEFAULT 0 CHECK (recorded_units >= 0 AND recorded_units <= planned_units),
    version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer_id, holder_ref),
    UNIQUE (issuer_id, subject_hash)
);

CREATE TABLE wallet_challenges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    holder_id uuid NOT NULL REFERENCES phase2_holders(id),
    wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
    chain_id integer NOT NULL CHECK (chain_id IN (31337, 84532)),
    nonce text NOT NULL,
    message text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE phase2_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_ref text NOT NULL,
    action text NOT NULL,
    idempotency_key uuid NOT NULL,
    request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    resource_version integer NOT NULL CHECK (resource_version >= 0),
    status text NOT NULL CHECK (status IN ('CONFIRMED', 'PENDING', 'RECONCILIATION_REQUIRED')),
    response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (actor_ref, action, idempotency_key)
);

CREATE FUNCTION reject_terms_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'prototype terms are append-only';
END;
$$;
CREATE TRIGGER prototype_terms_append_only BEFORE UPDATE OR DELETE ON prototype_terms
FOR EACH ROW EXECUTE FUNCTION reject_terms_change();

CREATE TABLE phase2_chain_steps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id uuid NOT NULL REFERENCES phase2_operations(id),
    step text NOT NULL CHECK (step IN ('ELIGIBILITY', 'ALLOCATION', 'MINT')),
    chain_id integer NOT NULL CHECK (chain_id IN (31337, 84532)),
    contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-fA-F]{40}$'),
    tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (operation_id, step),
    UNIQUE (chain_id, tx_hash, step)
);
