CREATE TABLE issuers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    public_id text NOT NULL UNIQUE,
    display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
    fictional boolean NOT NULL DEFAULT true CHECK (fictional),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_ref text NOT NULL CHECK (length(trim(actor_ref)) > 0),
    actor_role text NOT NULL CHECK (length(trim(actor_role)) > 0),
    action text NOT NULL CHECK (length(trim(action)) > 0),
    resource_type text NOT NULL CHECK (length(trim(resource_type)) > 0),
    resource_id uuid NOT NULL,
    source_version text NOT NULL CHECK (length(trim(source_version)) > 0),
    before_hash text,
    after_hash text,
    reason text NOT NULL CHECK (length(trim(reason)) > 0),
    request_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    formula_version text,
    policy_version text,
    terms_version text,
    approval_id uuid,
    chain_command_id uuid,
    chain_event_id uuid
);

CREATE FUNCTION reject_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_events are append-only';
END;
$$;

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_change();

CREATE TABLE outbox_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id uuid NOT NULL,
    event_type text NOT NULL CHECK (length(trim(event_type)) > 0),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'DELIVERED', 'RECONCILIATION_REQUIRED')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (operation_id, event_type)
);

CREATE INDEX outbox_events_pending_idx ON outbox_events (created_at, id)
WHERE status IN ('PENDING', 'RECONCILIATION_REQUIRED');
