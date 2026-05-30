-- Allow multiple autoresponder draft runs per contact+campaign thread.
-- Superseded open drafts are cancelled in application code when a new run starts.

DROP INDEX IF EXISTS uq_interested_autoresponder_drafts_open_thread;
