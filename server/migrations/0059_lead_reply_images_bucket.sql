-- 0059_lead_reply_images_bucket.sql
-- Purpose: public Storage bucket for images attached to free-hand lead replies.
-- Instantly's /emails/reply has no attachments field, so images are hosted
-- here and embedded as <img src> in the reply HTML — the bucket must be public
-- for the lead's mail client to render them. Object paths are unguessable
-- (agency/contact/<timestamp>-<uuid>.<ext>). Writes go through the server
-- with the service-role key only; no storage.objects policies are needed.
-- The server also creates this bucket on first use (leadManualReply.js), so
-- this migration is belt-and-braces for prod parity.

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'lead-reply-images',
    'lead-reply-images',
    TRUE,
    10485760,
    ARRAY['image/png', 'image/jpeg', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
    SET public = EXCLUDED.public,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

COMMIT;
