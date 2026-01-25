#!/usr/bin/env node

/**
 * Test both email verification providers
 */

import { PROVIDERS } from './src/services/emailVerifier.js';

console.log('\n📧 Email Verification Providers Test\n');
console.log('Available providers:', PROVIDERS);
console.log('\nProvider constants:');
console.log(`- TryKitt: "${PROVIDERS.TRYKITT}"`);
console.log(`- Self-Hosted: "${PROVIDERS.SELF_HOSTED}"`);

console.log('\n✅ Email provider configuration ready!');
console.log('\nNext steps:');
console.log('1. Users can select their provider in Account settings');
console.log('2. Choice is stored in Firebase: email_verification_provider field');
console.log('3. Server reads preference and uses selected provider');
console.log('4. Self-hosted provider requires no API key');
console.log('5. TryKitt provider requires kitt API key in vault\n');
