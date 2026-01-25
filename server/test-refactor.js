#!/usr/bin/env node

/**
 * Test Suite: Cloud SQL Refactor Verification
 * 
 * IMPORTANT: The deployed database schema includes FULL CLIENT SUPPORT (not MVP).
 * This means:
 * - clients table exists and is required
 * - company.client_id is NOT NULL (required)
 * - contacts.client_id is NOT NULL (required)
 *
 * Tests verify the actual deployed schema works correctly.
 */

import { config } from 'dotenv';
import { pool, testConnection } from './src/config/db.js';
import { withTx } from './src/lib/db.js';

config();

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

let testsPassed = 0;
let testsFailed = 0;

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function assert(condition, message) {
    if (condition) {
        testsPassed++;
        log(`  ✓ ${message}`, 'green');
    } else {
        testsFailed++;
        log(`  ✗ ${message}`, 'red');
        throw new Error(`Assertion failed: ${message}`);
    }
}

async function runTest(testName, testFn) {
    try {
        log(`\n📋 ${testName}`, 'cyan');
        await testFn();
        log(`  ${testName} PASSED`, 'green');
    } catch (error) {
        log(`  ${testName} FAILED: ${error.message}`, 'red');
        testsFailed++;
    }
}

async function test_01_DatabaseConnectivity() {
    const ok = await testConnection();
    assert(ok === true, 'Database connection successful');
}

async function test_02_SchemaExists() {
    const client = await pool.connect();
    try {
        const tables = await client.query(`
            SELECT tablename FROM pg_tables 
            WHERE schemaname = 'public' 
            ORDER BY tablename
        `);
        
        const tableNames = tables.rows.map(r => r.tablename).sort();
        log(`  Found tables: ${tableNames.join(', ')}`, 'blue');
        
        assert(tableNames.includes('clients'), 'clients table exists');
        assert(tableNames.includes('companies'), 'companies table exists');
        assert(tableNames.includes('contacts'), 'contacts table exists');
        assert(tableNames.includes('job_stage_checkpoints'), 'job_stage_checkpoints table exists');
    } finally {
        client.release();
    }
}

async function test_03_CreateTestClient() {
    const testAgencyId = 'test-agency-' + Date.now();
    const testClientName = 'Test Client ' + Date.now();
    
    const result = await pool.query(
        `INSERT INTO clients (agency_id, name) VALUES ($1, $2) RETURNING id, agency_id, name`,
        [testAgencyId, testClientName]
    );
    
    const clientId = result.rows[0].id;
    assert(typeof clientId === 'number', `Created test client with ID ${clientId}`);
    
    global.testClientId = clientId;
    global.testAgencyId = testAgencyId;
}

async function test_04_BatchInsertCompanies() {
    const clientId = global.testClientId;
    
    const query = `
        INSERT INTO companies (client_id, domain_normalized)
        VALUES 
            ($1, 'example.com'),
            ($1, 'google.com'),
            ($1, 'example.com')
        ON CONFLICT (client_id, domain_normalized)
        DO UPDATE SET updated_at = now()
        RETURNING id, domain_normalized
    `;
    
    const result = await pool.query(query, [clientId]);
    
    assert(result.rows.length === 2, 'Batch insert deduplicated to 2 unique domains');
    assert(result.rows.some(r => r.domain_normalized === 'example.com'), 'example.com inserted');
    
    global.companyIds = {};
    for (const row of result.rows) {
        global.companyIds[row.domain_normalized] = row.id;
    }
}

async function test_05_BatchInsertContacts() {
    const clientId = global.testClientId;
    const agencyId = global.testAgencyId;
    const companyId = global.companyIds['example.com'];
    
    const query = `
        INSERT INTO contacts (
            client_id, agency_id, company_id, role_type, 
            full_name, email, email_status, confidence
        )
        VALUES 
            ($1, $2, $3, 'founder', 'John Doe', 'john@example.com', 'valid', 0.95),
            ($1, $2, $3, 'dm', 'Jane Doe', 'jane@example.com', 'valid', 0.85)
        ON CONFLICT (company_id, role_type)
        DO UPDATE SET updated_at = now()
        RETURNING id, role_type, email
    `;
    
    const result = await pool.query(query, [clientId, agencyId, companyId]);
    
    assert(result.rows.length === 2, 'Batch contact insert created 2 contacts');
    assert(result.rows.some(r => r.role_type === 'founder'), 'founder contact inserted');
    
    global.contactIds = result.rows.map(r => r.id);
}

async function test_06_IdempotencyCheck() {
    const clientId = global.testClientId;
    
    const result1 = await pool.query(
        `INSERT INTO companies (client_id, domain_normalized) VALUES ($1, $2) 
         ON CONFLICT (client_id, domain_normalized) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [clientId, 'idempotent-test.com']
    );
    
    const result2 = await pool.query(
        `INSERT INTO companies (client_id, domain_normalized) VALUES ($1, $2) 
         ON CONFLICT (client_id, domain_normalized) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [clientId, 'idempotent-test.com']
    );
    
    assert(result1.rows[0].id === result2.rows[0].id, 'Idempotent upsert returns same ID');
}

async function test_07_CheckpointPersistence() {
    const clientId = global.testClientId;
    const agencyId = global.testAgencyId;
    const jobId = 'test-job-' + Date.now();
    
    const writeResult = await pool.query(
        `INSERT INTO job_stage_checkpoints (agency_id, client_id, job_id, stage, cursor)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (client_id, job_id, stage)
         DO UPDATE SET cursor = $5, updated_at = now()
         RETURNING agency_id, client_id, job_id, stage, cursor`,
        [agencyId, clientId, jobId, 'founder', '1000']
    );
    
    assert(writeResult.rows.length === 1, 'Checkpoint written');
    assert(writeResult.rows[0].cursor === '1000', 'Checkpoint cursor correct');
    
    const readResult = await pool.query(
        `SELECT * FROM job_stage_checkpoints 
         WHERE client_id = $1 AND job_id = $2 AND stage = $3`,
        [clientId, jobId, 'founder']
    );
    
    assert(readResult.rows.length === 1, 'Checkpoint persisted');
    assert(readResult.rows[0].cursor === '1000', 'Checkpoint cursor persisted');
}

async function test_08_SendSafety() {
    const clientId = global.testClientId;
    const contactIds = global.contactIds;
    
    const updateResult = await pool.query(
        `UPDATE contacts
         SET last_contacted_at = now(), updated_at = now()
         WHERE client_id = $1 AND id = ANY($2)
         RETURNING id, last_contacted_at`,
        [clientId, contactIds]
    );
    
    assert(updateResult.rows.length > 0, 'Marked contacts as contacted');
    assert(updateResult.rows[0].last_contacted_at !== null, 'last_contacted_at set');
    
    const untouched = await pool.query(
        `SELECT id FROM contacts
         WHERE client_id = $1 AND last_contacted_at IS NULL`,
        [clientId]
    );
    
    const untouchedIds = untouched.rows.map(r => r.id);
    for (const contactId of contactIds) {
        assert(!untouchedIds.includes(contactId), `Contact excluded from untouched list`);
    }
}

async function test_09_TransactionRollback() {
    const clientId = global.testClientId;
    
    try {
        await withTx(async (txClient) => {
            await txClient.query(
                `INSERT INTO companies (client_id, domain_normalized) VALUES ($1, $2)`,
                [clientId, 'rollback-test.com']
            );
            throw new Error('Simulated error');
        });
    } catch (error) {
        if (error.message !== 'Simulated error') throw error;
    }
    
    const result = await pool.query(
        `SELECT COUNT(*) as count FROM companies WHERE client_id = $1 AND domain_normalized = $2`,
        [clientId, 'rollback-test.com']
    );
    
    assert(parseInt(result.rows[0].count) === 0, 'Transaction rolled back on error');
}

async function test_10_MultiClientIsolation() {
    const agency1 = 'agency-1-' + Date.now();
    const agency2 = 'agency-2-' + Date.now();
    
    const client1Result = await pool.query(
        `INSERT INTO clients (agency_id, name) VALUES ($1, $2) RETURNING id`,
        [agency1, 'Client 1']
    );
    const clientId1 = client1Result.rows[0].id;
    
    const client2Result = await pool.query(
        `INSERT INTO clients (agency_id, name) VALUES ($1, $2) RETURNING id`,
        [agency2, 'Client 2']
    );
    const clientId2 = client2Result.rows[0].id;
    
    await pool.query(
        `INSERT INTO companies (client_id, domain_normalized) VALUES ($1, $2)`,
        [clientId1, 'shared-domain.com']
    );
    
    await pool.query(
        `INSERT INTO companies (client_id, domain_normalized) VALUES ($1, $2)`,
        [clientId2, 'shared-domain.com']
    );
    
    const client1Companies = await pool.query(
        `SELECT id FROM companies WHERE client_id = $1 AND domain_normalized = $2`,
        [clientId1, 'shared-domain.com']
    );
    
    const client2Companies = await pool.query(
        `SELECT id FROM companies WHERE client_id = $1 AND domain_normalized = $2`,
        [clientId2, 'shared-domain.com']
    );
    
    assert(client1Companies.rows.length === 1, 'Client 1 sees their company');
    assert(client2Companies.rows.length === 1, 'Client 2 sees their company');
    assert(
        client1Companies.rows[0].id !== client2Companies.rows[0].id,
        'Same domain has different IDs per client'
    );
    
    await pool.query('DELETE FROM companies WHERE client_id IN ($1, $2)', [clientId1, clientId2]);
    await pool.query('DELETE FROM clients WHERE id IN ($1, $2)', [clientId1, clientId2]);
}

async function test_11_Cleanup() {
    if (global.testClientId) {
        try {
            await pool.query('DELETE FROM contacts WHERE client_id = $1', [global.testClientId]);
            await pool.query('DELETE FROM companies WHERE client_id = $1', [global.testClientId]);
            await pool.query('DELETE FROM job_stage_checkpoints WHERE client_id = $1', [global.testClientId]);
            await pool.query('DELETE FROM clients WHERE id = $1', [global.testClientId]);
            log('  Cleaned up test data', 'blue');
        } catch (error) {
            log(`  Cleanup warning: ${error.message}`, 'yellow');
        }
    }
}

async function runAllTests() {
    log('\n' + '='.repeat(60), 'blue');
    log('🚀 CLOUD SQL REFACTOR TEST SUITE', 'blue');
    log('='.repeat(60) + '\n', 'blue');
    
    try {
        await runTest('Test 01: Database Connectivity', test_01_DatabaseConnectivity);
        await runTest('Test 02: Schema Tables Exist', test_02_SchemaExists);
        await runTest('Test 03: Create Test Client', test_03_CreateTestClient);
        await runTest('Test 04: Batch Insert Companies', test_04_BatchInsertCompanies);
        await runTest('Test 05: Batch Insert Contacts', test_05_BatchInsertContacts);
        await runTest('Test 06: Idempotency Check', test_06_IdempotencyCheck);
        await runTest('Test 07: Checkpoint Persistence', test_07_CheckpointPersistence);
        await runTest('Test 08: Send-Safety Tracking', test_08_SendSafety);
        await runTest('Test 09: Transaction Rollback', test_09_TransactionRollback);
        await runTest('Test 10: Multi-Client Isolation', test_10_MultiClientIsolation);
        await runTest('Test 11: Cleanup', test_11_Cleanup);
    } finally {
        await pool.end();
    }
    
    log('\n' + '='.repeat(60), 'blue');
    log(`📊 TEST RESULTS: ${testsPassed} passed, ${testsFailed} failed`, 
        testsFailed === 0 ? 'green' : 'red');
    log('='.repeat(60) + '\n', 'blue');
    
    process.exit(testsFailed === 0 ? 0 : 1);
}

runAllTests().catch(error => {
    log(`\n❌ FATAL ERROR: ${error.message}`, 'red');
    process.exit(1);
});
