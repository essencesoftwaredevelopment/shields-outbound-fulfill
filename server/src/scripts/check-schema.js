#!/usr/bin/env node

const { query, pool } = require('../lib/db.js');

async function checkSchema() {
  try {
    console.log('Checking companies table schema...\n');
    
    // Get column information
    const columnsResult = await query(`
      SELECT 
        column_name, 
        data_type, 
        is_nullable,
        column_default
      FROM information_schema.columns 
      WHERE table_name = 'companies'
      ORDER BY ordinal_position
    `);
    
    console.log('=== COLUMNS ===');
    columnsResult.rows.forEach(row => {
      console.log(`  ${row.column_name}: ${row.data_type} ${row.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'} ${row.column_default || ''}`);
    });
    
    // Get constraint information
    const constraintsResult = await query(`
      SELECT 
        conname as constraint_name,
        pg_get_constraintdef(oid) as definition
      FROM pg_constraint 
      WHERE conrelid = 'companies'::regclass
      ORDER BY conname
    `);
    
    console.log('\n=== CONSTRAINTS ===');
    constraintsResult.rows.forEach(row => {
      console.log(`  ${row.constraint_name}:`);
      console.log(`    ${row.definition}`);
    });
    
    await pool.end();
  } catch (error) {
    console.error('Error checking schema:', error.message);
    process.exit(1);
  }
}

checkSchema();
