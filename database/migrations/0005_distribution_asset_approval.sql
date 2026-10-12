ALTER TABLE distribution_chain_steps DROP CONSTRAINT distribution_chain_steps_step_check;
ALTER TABLE distribution_chain_steps ADD CONSTRAINT distribution_chain_steps_step_check
CHECK (step IN ('VAULT_DEPLOY','ASSET_APPROVAL','FUND','OPEN'));
