CREATE TABLE distribution_reconciliation_incidents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    epoch_id uuid NOT NULL REFERENCES distribution_epochs(id),
    operation_id uuid REFERENCES distribution_operations(id),
    code text NOT NULL CHECK (length(trim(code)) > 0),
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER distribution_reconciliation_incidents_append_only
BEFORE UPDATE OR DELETE ON distribution_reconciliation_incidents
FOR EACH ROW EXECUTE FUNCTION reject_financial_evidence_change();
