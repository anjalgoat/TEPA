ALTER TABLE distribution_epochs ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE distribution_epochs DROP CONSTRAINT distribution_epochs_issuer_id_quarter_key;
ALTER TABLE distribution_epochs ADD CONSTRAINT distribution_epochs_issuer_quarter_revision_key
UNIQUE (issuer_id, quarter, revision);
