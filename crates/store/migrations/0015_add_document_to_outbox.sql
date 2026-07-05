ALTER TABLE telegram_outbox
ADD COLUMN document_name VARCHAR(255),
ADD COLUMN document_content BYTEA;
