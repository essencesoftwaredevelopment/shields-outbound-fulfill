import dotenv from 'dotenv';
dotenv.config({ path: './.secrets/.env' });
const { pool } = await import('./src/config/db.js');
const CID = 491002, OLD = 408824;

for (const [label, id] of [['Cut Klaviyo Bill (Personalization)', CID], ['Cut Klaviyo Bill (working)', OLD]]) {
  console.log(`\n########## ${label} — campaign ${id} ##########`);
  const ev = await pool.query(
    `SELECT event_type, source, COUNT(*) AS n, MAX(event_timestamp) AS latest
     FROM contact_instantly_events WHERE campaign_id = $1
     GROUP BY event_type, source ORDER BY latest DESC NULLS LAST`, [id]);
  console.log('--- events by type ---');
  console.table(ev.rows);

  const d = await pool.query(
    `SELECT status, COUNT(*) AS n, MAX(created_at) AS latest
     FROM interested_autoresponder_drafts WHERE campaign_id = $1
     GROUP BY status ORDER BY latest DESC NULLS LAST`, [id]);
  console.log('--- drafts by status ---');
  console.table(d.rows.length ? d.rows : [{ status: '(none)' }]);

  const cic = await pool.query(
    `SELECT interest_status, last_event_type, COUNT(*) AS n
     FROM contact_instantly_campaigns WHERE campaign_id = $1
     GROUP BY interest_status, last_event_type ORDER BY n DESC LIMIT 10`, [id]);
  console.log('--- membership interest status ---');
  console.table(cic.rows);
}
await pool.end();
