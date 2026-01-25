import { pool } from './src/lib/db.js';

(async () => {
  try {
    const result = await pool.query(`
      SELECT conname, pg_get_constraintdef(oid) as definition
      FROM pg_constraint
      WHERE conrelid = 'clients'::regclass
      AND contype = 'u'
    `);
    
    console.log('\nUnique constraints on clients table:');
    result.rows.forEach(row => {
      console.log(`  ✓ ${row.conname}`);
      console.log(`    ${row.definition}`);
    });
    
    if (result.rows.length === 0) {
      console.log('  ⚠️  No unique constraints found');
    }
    
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    await pool.end();
    process.exit(1);
  }
})();
