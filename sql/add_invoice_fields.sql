-- Invoice + WhatsApp invoice columns (already present on production Neon).
-- Safe to run multiple times.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_url TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_generated_at TIMESTAMP NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_status VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS whatsapp_invoice_status VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS whatsapp_invoice_message_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS whatsapp_invoice_sent_at TIMESTAMP NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS whatsapp_invoice_error TEXT;
