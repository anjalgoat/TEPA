CREATE FUNCTION protect_phase4_appraisal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'appraisal evidence is append-only'; END IF;
    IF NEW.issuer_id IS DISTINCT FROM OLD.issuer_id OR NEW.input IS DISTINCT FROM OLD.input
       OR NEW.input_sha256 IS DISTINCT FROM OLD.input_sha256
       OR NEW.pool_usd_minor IS DISTINCT FROM OLD.pool_usd_minor
       OR NEW.indicative_unit_usd_minor IS DISTINCT FROM OLD.indicative_unit_usd_minor
       OR NEW.prepared_by IS DISTINCT FROM OLD.prepared_by
       OR OLD.state <> 'DRAFT' OR NEW.state <> 'APPROVED'
       OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
        RAISE EXCEPTION 'approved appraisal inputs cannot change';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER phase4_appraisal_protected BEFORE UPDATE OR DELETE ON phase4_appraisals
FOR EACH ROW EXECUTE FUNCTION protect_phase4_appraisal();

CREATE FUNCTION protect_phase4_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'settlement cases cannot be deleted'; END IF;
    IF NEW.issuer_id IS DISTINCT FROM OLD.issuer_id OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.appraisal_id IS DISTINCT FROM OLD.appraisal_id OR NEW.terms_id IS DISTINCT FROM OLD.terms_id
       OR NEW.input IS DISTINCT FROM OLD.input OR NEW.input_sha256 IS DISTINCT FROM OLD.input_sha256
       OR NEW.budget_usd_minor IS DISTINCT FROM OLD.budget_usd_minor
       OR NEW.binding_unit_price_usd_minor IS DISTINCT FROM OLD.binding_unit_price_usd_minor
       OR NEW.tender_deadline IS DISTINCT FROM OLD.tender_deadline
       OR NEW.prepared_by IS DISTINCT FROM OLD.prepared_by
       OR (OLD.record_block IS NOT NULL AND NEW.record_block IS DISTINCT FROM OLD.record_block)
       OR (OLD.record_block_hash IS NOT NULL AND NEW.record_block_hash IS DISTINCT FROM OLD.record_block_hash)
       OR (OLD.snapshot_hash IS NOT NULL AND NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash)
       OR (OLD.entitlement_root IS NOT NULL AND NEW.entitlement_root IS DISTINCT FROM OLD.entitlement_root)
       OR (OLD.committed_units IS NOT NULL AND NEW.committed_units IS DISTINCT FROM OLD.committed_units)
       OR (OLD.committed_usd_minor IS NOT NULL AND NEW.committed_usd_minor IS DISTINCT FROM OLD.committed_usd_minor)
       OR (OLD.vault_address IS NOT NULL AND NEW.vault_address IS DISTINCT FROM OLD.vault_address)
       OR (OLD.funding_tx_hash IS NOT NULL AND NEW.funding_tx_hash IS DISTINCT FROM OLD.funding_tx_hash)
       OR (OLD.opening_tx_hash IS NOT NULL AND NEW.opening_tx_hash IS DISTINCT FROM OLD.opening_tx_hash)
       OR (OLD.finalization_tx_hash IS NOT NULL AND NEW.finalization_tx_hash IS DISTINCT FROM OLD.finalization_tx_hash) THEN
        RAISE EXCEPTION 'settlement inputs and commitments cannot change';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER phase4_case_protected BEFORE UPDATE OR DELETE ON phase4_cases
FOR EACH ROW EXECUTE FUNCTION protect_phase4_case();

CREATE FUNCTION protect_phase4_tender() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'tender history cannot be deleted'; END IF;
    IF NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.holder_id IS DISTINCT FROM OLD.holder_id
       OR NEW.wallet_address IS DISTINCT FROM OLD.wallet_address
       OR NEW.tendered_units IS DISTINCT FROM OLD.tendered_units
       OR NEW.holding_units_at_submission IS DISTINCT FROM OLD.holding_units_at_submission
       OR OLD.status <> 'ACTIVE' OR NEW.status <> 'CANCELLED' OR NEW.cancelled_at IS NULL THEN
        RAISE EXCEPTION 'submitted tender terms cannot change';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER phase4_tender_protected BEFORE UPDATE OR DELETE ON phase4_tenders
FOR EACH ROW EXECUTE FUNCTION protect_phase4_tender();

CREATE TRIGGER phase4_chain_steps_append_only BEFORE UPDATE OR DELETE ON phase4_chain_steps
FOR EACH ROW EXECUTE FUNCTION reject_financial_evidence_change();
