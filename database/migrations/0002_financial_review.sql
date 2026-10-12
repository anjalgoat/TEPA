ALTER TABLE issuers DROP CONSTRAINT issuers_version_check;
ALTER TABLE issuers ALTER COLUMN version SET DEFAULT 0;
ALTER TABLE issuers ADD CONSTRAINT issuers_version_check CHECK (version >= 0);

CREATE TABLE financial_imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer_id uuid NOT NULL REFERENCES issuers(id),
    fixture_version integer NOT NULL CHECK (fixture_version IN (1, 2)),
    input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
    imported_by text NOT NULL CHECK (length(trim(imported_by)) > 0),
    imported_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer_id, fixture_version)
);

ALTER TABLE issuers ADD COLUMN active_import_id uuid REFERENCES financial_imports(id);

CREATE TABLE financial_source_rows (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    import_id uuid NOT NULL REFERENCES financial_imports(id),
    source_ref text NOT NULL,
    source_system text NOT NULL CHECK (source_system IN ('PROCESSOR', 'BANK', 'LEDGER', 'EXPENSE', 'DEBT')),
    period text NOT NULL CHECK (period ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
    category text NOT NULL CHECK (category IN ('RECEIPT', 'OPERATING', 'TAX', 'RESERVE', 'EXCLUDED', 'DEBT_SERVICE')),
    amount_minor numeric(78, 0) NOT NULL CHECK (amount_minor >= 0),
    currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    decimals integer NOT NULL DEFAULT 2 CHECK (decimals = 2),
    evidence_ref text NOT NULL CHECK (evidence_ref LIKE 'synthetic:%'),
    related_party boolean NOT NULL,
    row_sha256 text NOT NULL CHECK (row_sha256 ~ '^[0-9a-f]{64}$'),
    UNIQUE (import_id, source_ref)
);

CREATE TABLE customer_metric_rows (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    import_id uuid NOT NULL REFERENCES financial_imports(id),
    source_ref text NOT NULL,
    period text NOT NULL CHECK (period ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
    active_customers integer NOT NULL CHECK (active_customers >= 0),
    arr_minor numeric(78, 0) NOT NULL CHECK (arr_minor >= 0),
    churn_basis_points integer NOT NULL CHECK (churn_basis_points BETWEEN 0 AND 10000),
    evidence_ref text NOT NULL CHECK (evidence_ref LIKE 'synthetic:%'),
    row_sha256 text NOT NULL CHECK (row_sha256 ~ '^[0-9a-f]{64}$'),
    UNIQUE (import_id, source_ref),
    UNIQUE (import_id, period)
);

CREATE TABLE financial_review_cases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    import_id uuid NOT NULL REFERENCES financial_imports(id),
    case_key text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('BANK_MISMATCH', 'LEDGER_MISMATCH', 'RELATED_PARTY')),
    period text NOT NULL,
    source_refs text[] NOT NULL CHECK (cardinality(source_refs) > 0),
    delta_minor numeric(78, 0) NOT NULL,
    suggestion text NOT NULL,
    status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
    resolution_code text,
    reason text,
    reviewed_by text,
    reviewed_at timestamptz,
    UNIQUE (import_id, case_key),
    CHECK (
        (status = 'OPEN' AND resolution_code IS NULL AND reason IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL)
        OR
        (status = 'RESOLVED' AND resolution_code IS NOT NULL AND length(trim(reason)) > 0 AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    )
);

CREATE TABLE financial_approvals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    import_id uuid NOT NULL UNIQUE REFERENCES financial_imports(id),
    input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
    decisions_sha256 text NOT NULL CHECK (decisions_sha256 ~ '^[0-9a-f]{64}$'),
    formula_version text NOT NULL,
    approved_by text NOT NULL,
    reason text NOT NULL CHECK (length(trim(reason)) > 0),
    approved_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE financial_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_ref text NOT NULL,
    action text NOT NULL,
    idempotency_key uuid NOT NULL,
    request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    resource_version integer NOT NULL CHECK (resource_version > 0),
    status text NOT NULL CHECK (status = 'CONFIRMED'),
    response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (actor_ref, action, idempotency_key)
);

CREATE FUNCTION reject_financial_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'financial evidence is append-only';
END;
$$;

CREATE TRIGGER financial_imports_append_only BEFORE UPDATE OR DELETE ON financial_imports
FOR EACH ROW EXECUTE FUNCTION reject_financial_evidence_change();
CREATE TRIGGER financial_source_rows_append_only BEFORE UPDATE OR DELETE ON financial_source_rows
FOR EACH ROW EXECUTE FUNCTION reject_financial_evidence_change();
CREATE TRIGGER customer_metric_rows_append_only BEFORE UPDATE OR DELETE ON customer_metric_rows
FOR EACH ROW EXECUTE FUNCTION reject_financial_evidence_change();
CREATE TRIGGER financial_approvals_append_only BEFORE UPDATE OR DELETE ON financial_approvals
FOR EACH ROW EXECUTE FUNCTION reject_financial_evidence_change();
