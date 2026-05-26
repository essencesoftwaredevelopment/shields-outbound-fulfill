-- Pipeline activity is stored in jobs.options (activityMessage); drop unused logs column.
ALTER TABLE jobs DROP COLUMN IF EXISTS logs;
