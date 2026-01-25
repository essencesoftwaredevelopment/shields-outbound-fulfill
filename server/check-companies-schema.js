import { pool } from './src/lib/db.js';

(async () => {
  try {
    const result = await pool.query(`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'companies'
      ORDER BY ordinal_position
    `);
    
    console.log('\nCompanies table schema:');
    result.rows.forEach(row => {
      console.log(`  ${row.column_name}: ${row.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'}`);
    });
    
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    await pool.end();
    process.exit(1);
  }
})();
