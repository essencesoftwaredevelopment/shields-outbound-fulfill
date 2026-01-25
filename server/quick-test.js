#!/usr/bin/env node

// Quick connectivity test
import { config } from 'dotenv';
import { testConnection } from './src/config/db.js';

config();

console.log('Testing database connection...');
console.log('Timeout set to 5 seconds...\n');

setTimeout(() => {
    console.error('Connection test TIMEOUT - database unreachable');
    process.exit(1);
}, 5000);

try {
    const result = await testConnection();
    console.log(`✓ Connection successful: ${result}`);
    process.exit(0);
} catch (error) {
    console.error(`✗ Connection failed: ${error.message}`);
    process.exit(1);
}
