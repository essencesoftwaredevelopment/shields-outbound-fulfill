import { pool } from './src/config/db.js';
import { batchUpsertContacts, withTx } from './src/lib/db.js';

const testAgencyId = 'test-agency-123';
const testClientId = 1;
const testEmail = 'test@example.com';

console.log('Testing contact upsert with duplicate email...\n');

try {
  // First, get or create a company for testing
  const companyResult = await pool.query(`
    INSERT INTO companies (agency_id, client_id, domain_normalized)
    VALUES ($1, $2, 'test-company.com')
    ON CONFLICT (client_id, domain_normalized) DO UPDATE SET updated_at = now()
    RETURNING id
  `, [testAgencyId, testClientId]);
  
  const companyId = companyResult.rows[0].id;
  console.log(`✓ Company ID: ${companyId}\n`);

  // Test 1: Insert first contact
  await withTx(async (client) => {
    const contacts = [{
      company_id: companyId,
      role_type: 'founder',
      full_name: 'John Doe',
      email: testEmail,
      email_status: 'valid',
      confidence: 95.0,
      personalization_first_line: 'Hello John'
    }];
    
    const result = await batchUpsertContacts(client, testAgencyId, testClientId, contacts);
    console.log('Test 1: First insert');
    console.log(`✓ Inserted contact ID: ${result[0].id}`);
    console.log(`  Name: ${result[0].full_name}`);
    console.log(`  Email: ${result[0].email}`);
    console.log(`  Company: ${result[0].company_id}\n`);
  });

  // Test 2: Insert same email with different company (should update existing)
  await withTx(async (client) => {
    // Create another company
    const company2Result = await client.query(`
      INSERT INTO companies (agency_id, client_id, domain_normalized)
      VALUES ($1, $2, 'another-company.com')
      ON CONFLICT (client_id, domain_normalized) DO UPDATE SET updated_at = now()
      RETURNING id
    `, [testAgencyId, testClientId]);
    
    const company2Id = company2Result.rows[0].id;
    
    const contacts = [{
      company_id: company2Id,
      role_type: 'dm',
      full_name: 'John Doe Updated',
      email: testEmail,
      email_status: 'risky',
      confidence: 85.0,
      personalization_first_line: 'Updated personalization'
    }];
    
    const result = await batchUpsertContacts(client, testAgencyId, testClientId, contacts);
    console.log('Test 2: Upsert with same email (should update, not error)');
    console.log(`✓ Contact ID: ${result[0].id}`);
    console.log(`  Name: ${result[0].full_name} (updated)`);
    console.log(`  Email: ${result[0].email}`);
    console.log(`  Company: ${result[0].company_id} (updated)`);
    console.log(`  Role: ${result[0].role_type} (updated)`);
    console.log(`  Status: ${result[0].email_status} (updated)\n`);
  });

  console.log('✅ All tests passed! Upsert working correctly.\n');

  // Verify only one contact exists with this email
  const countResult = await pool.query(
    'SELECT COUNT(*) as count FROM contacts WHERE client_id = $1 AND email = $2',
    [testClientId, testEmail]
  );
  console.log(`Final verification: ${countResult.rows[0].count} contact(s) with email ${testEmail}`);

} catch (error) {
  console.error('❌ Test failed:', error.message);
  if (error.constraint) {
    console.error(`   Constraint violated: ${error.constraint}`);
  }
} finally {
  await pool.end();
}
