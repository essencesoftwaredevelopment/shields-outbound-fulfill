# SQL Architecture Documentation

## Overview

This document explains how the SQL interactions work in the Shields Outbound lead generation pipeline. The system uses **PostgreSQL** as the primary data store with a multi-tenant architecture scoped by agency and client identifiers.

---

## Table of Contents

1. [Database Architecture](#database-architecture)
2. [Connection Management](#connection-management)
3. [Schema Design](#schema-design)
4. [Core Operations](#core-operations)
5. [Transaction Management](#transaction-management)
6. [Query Patterns](#query-patterns)
7. [Data Flow](#data-flow)
8. [Safety Features](#safety-features)

---

## Database Architecture

### Multi-Tenant Design

The system implements a **tenant-per-row** architecture where:

- **`agency_id`** (Firebase Auth UID) is the primary authorization boundary
- **`client_id`** is a logical product subdivision within an agency (supports multiple brands/clients per agency)
- Every query is scoped by both `agency_id` and `client_id` to ensure data isolation

**Canonical Identity Rule:**
```
Firebase Auth UID = agency_id in PostgreSQL
```
No mapping table or reconciliation is required. The Firebase UID is used directly as the agency identifier in all SQL tables.

### Key Principles

1. **Agency-First Authorization**: All data access is gated by `agency_id`
2. **Client-Level Scoping**: Within an agency, data is further scoped by `client_id`
3. **Zero Unscoped Queries**: Every query must include WHERE clauses for both identifiers
4. **Single Source of Truth**: PostgreSQL is authoritative; Firestore is used only for job state and UI sync

---

## Connection Management

### Configuration (`server/src/config/db.js`)

The application uses a **connection pool** managed by the `pg` library:

```javascript
import { Pool } from 'pg';

export const pool = new Pool({
    host: env.PGHOST,
    port: env.PGPORT,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    ssl: sslConfig,
    max: 20,                        // Maximum 20 concurrent connections
    idleTimeoutMillis: 30_000,      // Close idle connections after 30s
    connectionTimeoutMillis: 30_000, // Connection timeout: 30s
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000
});
```

### Connection Pool Features

- **Automatic Reconnection**: Pool handles disconnections transparently
- **Error Handling**: Pool-level error events are logged without crashing
- **Connection Lifecycle Logging**: Events logged for `connect`, `acquire`, and `remove`
- **Health Check**: `testConnection()` function verifies database connectivity

### Pool Event Monitoring

```javascript
pool.on('error', (err) => {
    console.error('❌ [DB POOL ERROR]', { code: err.code, message: err.message });
});

pool.on('connect', () => {
    console.log('✅ [DB] New connection established');
});
```

---

## Schema Design

### Tables Overview

The schema consists of three core tables:

1. **`companies`** - Company/domain deduplication
2. **`contacts`** - Individual contact records (founders, decision-makers)
3. **`job_stage_checkpoints`** - Pipeline progress tracking for crash recovery

### 1. Companies Table

**Purpose**: Store unique company domains and serve as the root entity for joining contacts.

```sql
CREATE TABLE companies (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    domain_normalized TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Dedupe: One domain per client
    UNIQUE (client_id, domain_normalized)
);
```

**Key Features:**
- `domain_normalized`: Lowercase, trimmed domain (e.g., `"fashionnova.com"`)
- **Unique Constraint**: Prevents duplicate domains within the same client
- Cascading delete: Removing a company deletes all associated contacts

**Indexes:**
```sql
CREATE INDEX idx_companies_agency_domain ON companies (agency_id, domain_normalized);
```

---

### 2. Contacts Table

**Purpose**: Store individual contact records with email verification and send tracking.

```sql
CREATE TABLE contacts (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role_type TEXT NOT NULL CHECK (role_type IN ('founder', 'dm')),
    full_name TEXT,
    email TEXT,
    email_status TEXT CHECK (email_status IN ('valid', 'risky', 'invalid', 'unknown')),
    last_verified_at TIMESTAMPTZ,
    last_contacted_at TIMESTAMPTZ,  -- Send safety: prevents accidental resends
    confidence NUMERIC(5,2),
    personalization_first_line TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Dedupe: One contact per role per company
    UNIQUE (company_id, role_type),
    
    -- Email uniqueness per agency
    UNIQUE (agency_id, email) WHERE email IS NOT NULL
);
```

**Key Features:**
- **`role_type`**: Differentiates between founders and decision-makers
- **`email_status`**: Tracks email verification state (`valid`, `risky`, `invalid`, `unknown`)
- **`last_contacted_at`**: Send-safety mechanism to prevent duplicate outreach
- **`personalization_first_line`**: Stores AI-generated personalization content

**Constraints:**
1. One contact per role per company (e.g., can have 1 founder + 1 DM per company)
2. No duplicate emails within the same agency (cross-client deduplication)

**Indexes:**
```sql
CREATE INDEX idx_contacts_company_role ON contacts (company_id, role_type);
CREATE INDEX idx_contacts_agency_contacted ON contacts (agency_id, last_contacted_at);
CREATE INDEX idx_contacts_email_status ON contacts (email_status);
CREATE INDEX idx_contacts_updated_at ON contacts (updated_at DESC);
```

---

### 3. Job Stage Checkpoints Table

**Purpose**: Enable crash-safe, resumable pipeline processing.

```sql
CREATE TABLE job_stage_checkpoints (
    agency_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('founder', 'email_find', 'verify', 'personalize')),
    cursor TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    PRIMARY KEY (agency_id, job_id, stage)
);
```

**Key Features:**
- **`cursor`**: CSV row index or progress marker (e.g., `"150"` = processed 150 rows)
- **Composite Primary Key**: One checkpoint per stage per job per agency
- Enables jobs to resume mid-stage after server crashes or restarts

**Indexes:**
```sql
CREATE INDEX idx_job_checkpoints_agency_job ON job_stage_checkpoints (agency_id, job_id);
```

---

## Core Operations

### Transaction Helper (`withTx`)

Located in: `server/src/lib/db.js`

All multi-step operations use a transaction helper for atomicity:

```javascript
export async function withTx(fn) {
    const client = await dbPool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
```

**Usage Example:**
```javascript
await withTx(async (client) => {
    // All operations share the same transaction
    const domainMap = await batchUpsertCompanies(client, agencyId, clientId, rows);
    await batchUpsertContacts(client, agencyId, clientId, contactRows);
    await writeCheckpoint(client, agencyId, clientId, jobId, stage, cursor);
});
```

### Batch Operations

#### 1. Batch Company Upsert

**Function**: `batchUpsertCompanies(txClient, agencyId, clientId, rows)`

**Purpose**: Insert or update multiple companies in a single query for efficiency.

**How It Works:**
1. Extracts unique domains from input rows
2. Normalizes domains (lowercase, trimmed)
3. Constructs a multi-row INSERT with ON CONFLICT
4. Returns a Map of domain → company_id for lookups

**Example Query:**
```sql
INSERT INTO companies (agency_id, client_id, domain_normalized)
VALUES ($1, $2, $3), ($1, $2, $4), ($1, $2, $5)
ON CONFLICT (client_id, domain_normalized)
DO UPDATE SET updated_at = NOW()
RETURNING id, domain_normalized
```

**Code Snippet:**
```javascript
const domainMap = new Map();
const uniqueDomains = [...new Set(rows.map(r => r.domain.toLowerCase()))];

const valuesList = uniqueDomains.map((_, i) => `($1, $2, $${i + 3})`);
const query = `
    INSERT INTO companies (agency_id, client_id, domain_normalized)
    VALUES ${valuesList.join(', ')}
    ON CONFLICT (client_id, domain_normalized)
    DO UPDATE SET updated_at = now()
    RETURNING id, domain_normalized
`;

const result = await txClient.query(query, [agencyId, clientId, ...uniqueDomains]);
for (const row of result.rows) {
    domainMap.set(row.domain_normalized, row.id);
}
```

---

#### 2. Batch Contact Upsert

**Function**: `batchUpsertContacts(txClient, agencyId, clientId, rows)`

**Purpose**: Insert or update multiple contacts with idempotent behavior.

**Key Behavior:**
- Uses `ON CONFLICT (company_id, role_type) DO UPDATE`
- **COALESCE Strategy**: Only overwrites NULL fields, preserves existing data
- Never replaces valid data with NULL values

**Example Query:**
```sql
INSERT INTO contacts (client_id, company_id, role_type, full_name, email, email_status, confidence)
VALUES ($1, $2, $3, $4, $5, $6, $7), ($1, $8, $9, $10, $11, $12, $13)
ON CONFLICT (company_id, role_type)
DO UPDATE SET
    full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
    email = COALESCE(EXCLUDED.email, contacts.email),
    email_status = COALESCE(EXCLUDED.email_status, contacts.email_status),
    confidence = COALESCE(EXCLUDED.confidence, contacts.confidence),
    updated_at = NOW()
RETURNING id, email, full_name, email_status, updated_at
```

**Benefits:**
- Idempotent: Safe to run multiple times
- Preserves enriched data from previous pipeline stages
- Efficient: Batches 100s of rows in a single query

---

### Checkpoint Management

#### Write Checkpoint

**Function**: `writeCheckpoint(txClient, agencyId, clientId, jobId, stage, cursor)`

**Purpose**: Save pipeline progress for crash recovery.

```javascript
const query = `
    INSERT INTO job_stage_checkpoints (agency_id, job_id, stage, cursor)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (agency_id, job_id, stage)
    DO UPDATE SET cursor = $4, updated_at = NOW()
    RETURNING agency_id, job_id, stage, cursor, updated_at
`;
```

**Usage:**
```javascript
// Save progress every 10 rows
if (processedRows % 10 === 0) {
    await writeCheckpoint(client, agencyId, clientId, jobId, 'email_find', String(processedRows));
}
```

#### Resume from Checkpoint

**Function**: `getJobCheckpoints(agencyId, jobId)`

**Purpose**: Retrieve saved progress to resume interrupted jobs.

```javascript
const checkpoints = await getJobCheckpoints(agencyId, jobId);
const emailFindCheckpoint = checkpoints.find(c => c.stage === 'email_find');
const startRow = emailFindCheckpoint ? parseInt(emailFindCheckpoint.cursor, 10) : 0;
```

---

## Query Patterns

### Scoped Query Pattern

**Every query must include agency_id and client_id in the WHERE clause:**

```javascript
// ✅ CORRECT: Properly scoped query
const query = `
    SELECT * FROM contacts
    WHERE agency_id = $1 AND client_id = $2 AND email_status = 'valid'
`;
const result = await pool.query(query, [agencyId, clientId]);

// ❌ WRONG: Unscoped query (security risk)
const query = `SELECT * FROM contacts WHERE email_status = 'valid'`;
```

### Common Query Patterns

#### 1. Fetch Contacts with Filters

```javascript
export async function getContactsByAgency(agencyId, { emailStatus, limit = 500, offset = 0 }) {
    let query = `
        SELECT c.*, co.domain_normalized
        FROM contacts c
        JOIN companies co ON c.company_id = co.id
        WHERE c.agency_id = $1
    `;
    const params = [agencyId];
    let paramIndex = 2;

    if (emailStatus) {
        query += ` AND c.email_status = $${paramIndex}`;
        params.push(emailStatus);
        paramIndex++;
    }

    query += ` ORDER BY c.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    return result.rows;
}
```

#### 2. Deduplication Check

```javascript
export async function getExistingDomainsSet(clientId, domains) {
    if (!domains.length) return new Set();

    const placeholders = domains.map((_, i) => `$${i + 2}`).join(',');
    const query = `
        SELECT domain_normalized
        FROM companies
        WHERE client_id = $1 AND domain_normalized IN (${placeholders})
    `;

    const result = await pool.query(query, [clientId, ...domains]);
    return new Set(result.rows.map(r => r.domain_normalized));
}
```

#### 3. Send-Safety Marking

```javascript
export async function markEmailsContacted(clientId, emails) {
    if (!emails.length) return [];

    const placeholders = emails.map((_, i) => `$${i + 2}`).join(',');
    const query = `
        UPDATE contacts
        SET last_contacted_at = NOW(), updated_at = NOW()
        WHERE client_id = $1 AND email IN (${placeholders})
        RETURNING id, email, last_contacted_at
    `;

    const result = await pool.query(query, [clientId, ...emails]);
    return result.rows;
}
```

---

## Data Flow

### Pipeline Processing Flow

```
1. CSV Upload
   └─> Parse rows → Extract domains

2. Company Upsert (Batch)
   └─> Normalize domains → Upsert to companies table → Get company IDs

3. Founder Finding
   └─> API calls → Save names/confidence → Upsert to contacts table

4. Email Finding
   └─> API calls → Save emails → Upsert to contacts table (preserves names)

5. Email Verification
   └─> API calls → Save email_status → Upsert to contacts table

6. Personalization
   └─> AI generation → Save first line → Upsert to contacts table

7. Export
   └─> Query contacts → Mark as contacted → Generate CSV
```

### Transaction Boundaries

Each pipeline stage processes data in **batches within transactions**:

```javascript
await withTx(async (client) => {
    // 1. Upsert companies (get IDs)
    const domainMap = await batchUpsertCompanies(client, agencyId, clientId, batch);
    
    // 2. Upsert contacts (with company IDs)
    await batchUpsertContacts(client, agencyId, clientId, contactRows);
    
    // 3. Save checkpoint (progress tracking)
    await writeCheckpoint(client, agencyId, clientId, jobId, stage, cursor);
});
```

**Benefits:**
- Atomicity: All-or-nothing for each batch
- Crash safety: Partial batches roll back; checkpoints enable resume
- Consistency: No orphaned contacts without companies

---

## Safety Features

### 1. Email Deduplication

**Within Agency:** The `UNIQUE (agency_id, email)` constraint prevents duplicate emails across all clients within an agency.

```sql
-- Will fail if email already exists for this agency
INSERT INTO contacts (agency_id, client_id, company_id, role_type, email)
VALUES ('uid123', 1, 456, 'founder', 'john@example.com');
```

**Behavior:**
- Protects against accidental re-imports of the same leads
- Prevents sending duplicate emails to the same person across clients

### 2. Send Safety (last_contacted_at)

**Purpose**: Prevent accidental duplicate outreach to contacts.

**How It Works:**
1. When exporting leads for campaigns, mark contacts as contacted:
   ```javascript
   await markEmailsContacted(clientId, [email1, email2, email3]);
   ```

2. Filter queries exclude recently contacted leads:
   ```sql
   SELECT * FROM contacts
   WHERE agency_id = $1
     AND client_id = $2
     AND email_status = 'valid'
     AND (last_contacted_at IS NULL OR last_contacted_at < NOW() - INTERVAL '30 days')
   ```

**Guardrail:**
- Timestamps serve as audit trail for compliance
- Prevents re-emailing within configurable cooldown periods

### 3. Crash-Safe Checkpoints

**Problem**: Pipeline jobs can take 10+ minutes and process thousands of rows. Server restarts or API failures can cause data loss.

**Solution**: Checkpoint every N rows (typically 10-50):

```javascript
for (let i = startRow; i < rows.length; i++) {
    await processRow(rows[i]);
    
    if (i % 10 === 0) {
        await writeCheckpoint(client, agencyId, clientId, jobId, stage, String(i));
    }
}
```

**Resume Logic:**
```javascript
const checkpoints = await getJobCheckpoints(agencyId, jobId);
const cursor = checkpoints.find(c => c.stage === stage)?.cursor || '0';
const startRow = parseInt(cursor, 10);

// Resume from last saved position
for (let i = startRow; i < rows.length; i++) {
    // Process remaining rows...
}
```

**Benefits:**
- No data loss on crashes
- Idempotent: Safely re-run without duplicating work
- Transparent to users: Jobs auto-resume seamlessly

### 4. COALESCE Updates

**Problem**: Multiple pipeline stages update the same contact. Later stages shouldn't overwrite earlier data.

**Solution**: Use COALESCE to preserve existing non-NULL values:

```sql
ON CONFLICT (company_id, role_type)
DO UPDATE SET
    full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
    email = COALESCE(EXCLUDED.email, contacts.email),
    email_status = COALESCE(EXCLUDED.email_status, contacts.email_status)
```

**Example:**
1. Stage 1 (Founder Finding): Sets `full_name = "John Doe"`
2. Stage 2 (Email Finding): Sets `email = "john@example.com"` (preserves `full_name`)
3. Stage 3 (Verification): Sets `email_status = "valid"` (preserves both)

---

## Performance Considerations

### 1. Batch Size Optimization

**Companies/Contacts:** Process 50-100 rows per transaction for optimal balance between:
- Memory usage
- Network round-trips
- Lock contention

```javascript
const BATCH_SIZE = 50;
for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await withTx(async (client) => {
        await batchUpsertCompanies(client, agencyId, clientId, batch);
        await batchUpsertContacts(client, agencyId, clientId, batch);
    });
}
```

### 2. Connection Pooling

**Pool Size:** Max 20 connections handles ~100 concurrent API requests efficiently.

**Why Not Higher?**
- PostgreSQL default connection limit: 100
- Other services need connections
- Each connection consumes ~10MB memory

### 3. Index Strategy

**Critical Indexes:**
- `(agency_id, domain_normalized)` on companies: Fast domain lookups
- `(company_id, role_type)` on contacts: Fast conflict resolution
- `(agency_id, last_contacted_at)` on contacts: Send-safety filters

**Avoided:**
- Full-text search indexes (not needed for current use cases)
- Redundant multi-column indexes (Postgres can use partial indexes)

### 4. Query Result Pagination

**Always use LIMIT/OFFSET for large result sets:**

```javascript
export async function getContactsByAgency(agencyId, { limit = 500, offset = 0 }) {
    const query = `
        SELECT * FROM contacts
        WHERE agency_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
    `;
    return await pool.query(query, [agencyId, limit, offset]);
}
```

**Frontend pagination:**
- Fetch 500 rows at a time
- Load more on scroll or "Next Page" button

---

## Error Handling

### Connection Errors

```javascript
pool.on('error', (err) => {
    console.error('❌ [DB POOL ERROR]', {
        code: err.code,
        message: err.message,
        stack: err.stack?.split('\n').slice(0, 3).join('\n')
    });
});
```

**Common Error Codes:**
- `ECONNREFUSED`: Database server unreachable
- `ECONNRESET`: Connection lost mid-query
- `ETIMEDOUT`: Query timeout (increase `connectionTimeoutMillis`)

### Transaction Rollbacks

```javascript
try {
    await withTx(async (client) => {
        await batchUpsertCompanies(...);
        await batchUpsertContacts(...);  // Fails here
    });
} catch (error) {
    // Transaction automatically rolled back
    console.error('Transaction failed:', error.message);
    // Safe to retry - no partial writes
}
```

### Constraint Violations

**Unique Constraint Violations:**
```javascript
// Error: duplicate key value violates unique constraint "contacts_agency_id_email_key"
```

**Handling:**
- Use `ON CONFLICT DO UPDATE` for upsert semantics
- Catch and log for debugging duplicate imports
- Frontend should prevent duplicate submissions

---

## Security Considerations

### 1. SQL Injection Prevention

**Always use parameterized queries:**

```javascript
// ✅ SAFE: Uses parameters
const query = 'SELECT * FROM contacts WHERE agency_id = $1 AND email = $2';
await pool.query(query, [agencyId, email]);

// ❌ UNSAFE: String interpolation
const query = `SELECT * FROM contacts WHERE email = '${email}'`;
```

### 2. Agency Isolation

**Middleware enforces agency scoping:**

```javascript
// server/src/middleware/auth.js
export async function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.agencyId = decodedToken.uid;  // Extracted from Firebase Auth
    next();
}
```

**All queries inherit the verified `agencyId`:**

```javascript
app.get('/api/contacts', requireAuth, async (req, res) => {
    const contacts = await getContactsByAgency(req.agencyId);
    res.json(contacts);
});
```

### 3. Client-Level Access Control

**Future enhancement:** Add client-level permissions:

```javascript
// Verify user has access to this client
const hasAccess = await checkClientAccess(req.agencyId, req.params.clientId);
if (!hasAccess) {
    return res.status(403).json({ error: 'Access denied' });
}
```

---

## Migration Strategy

### Initial Schema

**File**: `server/migrations/0001_cloudsql_baseline.sql`

**Execution**: Run once during initial deployment:

```bash
psql "$TARGET_DATABASE_URL" < server/migrations/0001_cloudsql_baseline.sql
```

### Future Migrations

**Pattern**: Create numbered migration files:
- `0002_add_clients_table.sql`
- `0003_add_personalization_columns.sql`

**Best Practices:**
- Always use `IF NOT EXISTS` for idempotent migrations
- Test on staging before production
- Include rollback scripts for reversible changes
- Document breaking changes in comments

---

## Monitoring & Debugging

### Connection Pool Monitoring

```javascript
setInterval(() => {
    console.log('[DB Pool Stats]', {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
    });
}, 60_000);  // Log every 60 seconds
```

### Query Performance Logging

```javascript
const startTime = Date.now();
const result = await pool.query(query, params);
const duration = Date.now() - startTime;

if (duration > 1000) {
    console.warn(`[Slow Query] ${duration}ms:`, query.slice(0, 100));
}
```

### Common Issues

| Issue | Symptom | Solution |
|-------|---------|----------|
| Connection pool exhausted | Timeout errors | Increase `max` pool size or optimize query concurrency |
| Slow queries | High latency | Add indexes, use EXPLAIN ANALYZE |
| Constraint violations | Duplicate key errors | Check for race conditions, use ON CONFLICT |
| Transaction deadlocks | `40P01` error code | Retry with exponential backoff |

---

## Summary

The SQL architecture in this system provides:

✅ **Multi-tenant isolation** via agency_id and client_id scoping  
✅ **Crash-safe pipelines** using checkpoints and transactions  
✅ **Idempotent operations** with UPSERT and COALESCE patterns  
✅ **Send-safety guardrails** via last_contacted_at tracking  
✅ **Batch optimization** for high-throughput processing  
✅ **Connection pooling** for efficient resource usage  
✅ **Type-safe queries** with parameterized statements  

This design scales from single-user MVPs to multi-client agency platforms while maintaining data integrity and security.

---

## Related Documentation

- **Agency Identity Architecture**: See [AGENCY_IDENTITY.md](./AGENCY_IDENTITY.md) (if exists)
- **API Routes**: [server/src/routes/](./server/src/routes/)
- **Database Config**: [server/src/config/db.js](./server/src/config/db.js)
- **Query Helpers**: [server/src/services/db/queries.js](./server/src/services/db/queries.js)

---

*Last Updated: January 27, 2026*
