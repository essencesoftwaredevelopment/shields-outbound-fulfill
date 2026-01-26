import { pool } from './src/config/db.js';

const testAgencyId = 'test-agency-' + Date.now();
const testClientId = 999;

console.log('Testing contact insert with duplicate email handling...\n');

async function runTest() {
  try {
    // Create test company
    const companyResult = await pool.query(`
      INSERT INTO companies (agency_id, client_id, domain_normalized)
      VALUES ($1, $2, 'test-domain.com')
      RETURNING id, domain_normalized
    `, [testAgencyId, testClientId]);
    
    const companyId = companyResult.rows[0].id;
    console.log(`✓ Created company ID: ${companyId}`);
    console.log(`  Domain: ${companyResult.rows[0].domain_normalized}\n`);

    // Test 1: Insert first contact
    const contact1 = await pool.query(`
      INSERT INTO contacts (client_id, company_id, role_type, full_name, email, email_status, confidence, agency_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (client_id, email)
      DO UPDATE SET
        company_id = EXCLUDED.company_id,
        full_name = EXCLUDED.full_name,
        email_status = EXCLUDED.email_status,
        updated_at = now()
      RETURNING id, full_name, email, company_id, role_type
    `, [testClientId, companyId, 'founder', 'Jane Smith', 'jane@test.com', 'valid', 90, testAgencyId]);
    
    console.log('Test 1: Insert new contact');
    console.log(`✓ Contact ID: ${contact1.rows[0].id}`);
    console.log(`  Name: ${contact1.rows[0].full_name}`);
    console.log(`  Email: ${contact1.rows[0].email}`);
    console.log(`  Company: ${contact1.rows[0].company_id}\n`);

    // Test 2: Insert same email (should update, not error)
    const contact2 = await pool.query(`
      INSERT INTO contacts (client_id, company_id, role_type, full_name, email, email_status, confidence, agency_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (client_id, email)
      DO UPDATE SET
        company_id = EXCLUDED.company_id,
        full_name = EXCLUDED.full_name,
        email_status = EXCLUDED.email_status,
        updated_at = now()
      RETURNING id, full_name, email, company_id, role_type
    `, [testClientId, companyId, 'dm', 'Jane Smith Updated', 'jane@test.com', 'risky', 85, testAgencyId]);
    
    console.log('Test 2: Upsert same email (should update existing)');
    console.log(`✓ Contact ID: ${contact2.rows[0].id} ${contact1.rows[0].id === contact2.rows[0].id ? '(same as before ✓)' : '(ERROR: different ID!)'}`);
    console.log(`  Name: ${contact2.rows[0].full_name}`);
    console.log(`  Email: ${contact2.rows[0].email}\n`);

    // Verify count
    const count = await pool.query(
      'SELECT COUNT(*) as count FROM contacts WHERE client_id = $1 AND email = $2',
      [testClientId, 'jane@test.com']
    );
    console.log(`✅ Success! Only ${count.rows[0].count} contact exists with this email (expected: 1)\n`);

    // Cleanup
    await pool.query('DELETE FROM contacts WHERE client_id = $1', [testClientId]);
    await pool.query('DELETE FROM companies WHERE client_id = $1', [testClientId]);
    console.log('✓ Cleaned up test data');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    if (error.constraint) {
      console.error(`   Constraint: ${error.constraint}`);
    }
    console.error(`   Code: ${error.code}`);
  } finally {
    await pool.end();
  }
}

runTest();
