/**
 * Local dry run of the interested-reply research pipeline for one domain.
 *
 * Exercises the real research steps (homepage fetch → Serper sweep → brief
 * synthesis) with an agency's actual keys, then prints the brief and the
 * popup-form payload that WOULD be sent. Touches nothing: no draft rows, no
 * popup API call, no workflow run.
 *
 * Usage:
 *   node --env-file=../.env.local src/scripts/test-interested-research.js <domain> [options]
 *
 * Options:
 *   --agency=<agencyId>   Agency whose Serper/OpenAI keys to use.
 *                         Default: first agency_settings row with both keys.
 *   --company=<name>      Company display name (default: humanized domain).
 *
 * Costs: one Serper call (3 queries) + one OpenAI call on the chosen agency's
 * keys — the same spend as one real research run, minus the reply generation.
 */
import { pool } from '../config/db.js';
import { getAgencySettings, apiKeysFromSettings } from '../services/db/agencySettings.js';
import { humanizeDomainAsCompanyName, normalizeAuditDomain } from '../services/interestedAutoResponder.js';
import {
    fetchHomepageForDomain,
    fetchSerperForTarget,
    synthesizeBriefFromContext
} from '../services/interestedResearch/index.js';

const args = process.argv.slice(2);
const rawDomain = args.find((a) => !a.startsWith('--'));
const agencyArg = args.find((a) => a.startsWith('--agency='))?.slice('--agency='.length);
const companyArg = args.find((a) => a.startsWith('--company='))?.slice('--company='.length);

const domain = normalizeAuditDomain(rawDomain);
if (!domain) {
    console.error('Usage: node src/scripts/test-interested-research.js <domain> [--agency=<id>] [--company=<name>]');
    process.exit(1);
}

async function resolveAgencyId() {
    if (agencyArg) return agencyArg;
    const result = await pool.query(
        `SELECT agency_id
         FROM agency_settings
         WHERE COALESCE(serper_key, '') <> '' AND COALESCE(openai_key, '') <> ''
         ORDER BY agency_id
         LIMIT 1`
    );
    return result.rows[0]?.agency_id || null;
}

const agencyId = await resolveAgencyId();
if (!agencyId) {
    console.error('No agency with both Serper and OpenAI keys found — pass --agency=<id>.');
    process.exit(1);
}
const settings = await getAgencySettings(agencyId);
const keys = apiKeysFromSettings(settings);
if (!keys.serper || !keys.openai) {
    console.error(`Agency ${agencyId} is missing a ${keys.serper ? 'OpenAI' : 'Serper'} key.`);
    process.exit(1);
}

const companyName = companyArg || humanizeDomainAsCompanyName(domain);
console.log(`\n=== Interested-research dry run ===`);
console.log(`domain:   ${domain}`);
console.log(`company:  ${companyName}`);
console.log(`agency:   ${agencyId} (keys only — nothing is written)\n`);

console.log('--- Step: homepage fetch + Serper sweep (parallel) ---');
const started = Date.now();
const [homepage, serper] = await Promise.all([
    fetchHomepageForDomain(domain),
    fetchSerperForTarget({ companyName, domain, serperKey: keys.serper })
]);
console.log(`elapsed: ${Date.now() - started}ms`);
if (homepage) {
    console.log(`homepage: title="${homepage.title}"`);
    console.log(`          description="${homepage.description}"`);
    console.log(`          text: ${homepage.text.length} chars`);
} else {
    console.log('homepage: null (unreachable / non-HTML / empty)');
}
if (serper?.results?.length) {
    console.log(`serper:   ${serper.results.length} results`);
    for (const r of serper.results.slice(0, 5)) {
        console.log(`          - ${r.title}${r.date ? ` (${r.date})` : ''}`);
    }
} else {
    console.log('serper:   null (no results or call failed)');
}

console.log('\n--- Step: brief synthesis (OpenAI) ---');
const briefStarted = Date.now();
const brief = await synthesizeBriefFromContext({
    openaiKey: keys.openai,
    companyName,
    domain,
    homepage,
    serper
});
console.log(`elapsed: ${Date.now() - briefStarted}ms`);

if (!brief) {
    console.log('brief: null — research too thin; a real run would draft WITHOUT a brief (same as today).');
} else {
    console.log('brief:');
    console.log(JSON.stringify(brief, null, 2));

    const popupPayload = {
        domain,
        ...(brief.industry ? { industry: brief.industry } : {}),
        ...(brief.company ? { companyName: brief.company } : {}),
        ...(brief.summary ? { summary: brief.summary } : {}),
        ...(brief.talkingPoints?.length ? { talkingPoints: brief.talkingPoints } : {}),
        ...(brief.estimatedVisitors ? { siteTraffic: brief.estimatedVisitors } : {}),
        ...(brief.reviewCount ? { reviewCount: brief.reviewCount } : {})
    };
    console.log('\n--- Popup-form generate payload (NOT sent) ---');
    console.log(JSON.stringify(popupPayload, null, 2));
}

await pool.end();
