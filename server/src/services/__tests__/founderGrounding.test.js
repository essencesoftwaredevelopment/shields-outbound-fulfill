import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    brandVariants,
    isStoreResult,
    groundFounderName,
    founderNameFromExtraction,
    buildDecisionsRequest,
    parseDecisionsResponse,
    DECISIONS_QUESTION
} from '../founderGrounding.js';
import { founderVerifyOptionsFromFeatures } from '../db/agencySettings.js';
import { validateFeaturesPatch } from '../db/featureFlagRegistry.js';

// Search results trimmed from job 1792511798642-7pq8g1 (batch 19).
const NASEYLA = [
    { title: 'Nuseir Yassin, Founder & CEO- Nas Daily We sat down ...', link: 'https://www.instagram.com/reel/x', snippet: 'Nuseir Yassin is the founder of Nas Daily.' },
    { title: 'Nayla Atallah - Founder & CEO at NAYLA', link: 'https://www.linkedin.com/in/nayla-atallah', snippet: 'Founder & CEO at NAYLA' }
];
const SKEYO = [
    { title: 'About', link: 'https://skeyooutdoors.com/pages/about', snippet: 'Courtney, Skeyo founder, standing in the Colorado mountains at golden hour.' },
    { title: 'Courtney Despos, PT, DPT, OCS - Founder & CEO, Skeyo', link: 'https://www.linkedin.com/in/x', snippet: 'Founder & CEO, Skeyo | Left corporate to build a D2C outdoor brand' }
];
const TRUECO = [
    { title: 'True Co. (True Gum, True Dates, True Mints)', link: 'https://thehub.io/startups/true-gum', snippet: 'Founded 2017. Founder, Co-Founder & CEO Jacob Motzfeld' }
];

describe('brandVariants', () => {
    it('strips storefront prefixes and category suffixes', () => {
        assert.ok(brandVariants('tryriora.com').includes('riora'));
        assert.ok(brandVariants('skeyooutdoors.com').includes('skeyo'));
        assert.ok(brandVariants('truecompany.com').includes('true'));
    });

    it('drops variants shorter than four letters', () => {
        assert.deepEqual(brandVariants('kolab.com'), ['kolab']);
    });
});

describe('isStoreResult', () => {
    it('matches the store domain, its subdomains and brand mentions', () => {
        assert.ok(isStoreResult({ link: 'https://www.skeyooutdoors.com/pages/about' }, 'skeyooutdoors.com'));
        assert.ok(isStoreResult({ link: 'https://shop.skeyooutdoors.com/' }, 'skeyooutdoors.com'));
        assert.ok(isStoreResult(SKEYO[1], 'skeyooutdoors.com'));
    });

    it('needs a whole word for short brand spellings', () => {
        assert.ok(isStoreResult(TRUECO[0], 'truecompany.com'));
        assert.ok(!isStoreResult({ title: 'Truthful skincare', link: 'https://x.com', snippet: 'untrue claims' }, 'truecompany.com'));
    });

    it('does not treat another company as the store', () => {
        assert.ok(!NASEYLA.some((r) => isStoreResult(r, 'naseyla.com')));
    });
});

describe('groundFounderName', () => {
    it('rejects a famous founder of an unrelated company', () => {
        assert.equal(groundFounderName({ firstName: 'Nuseir', lastName: 'Yassin' }, NASEYLA, 'naseyla.com').grounded, false);
    });

    it('grounds a full name on a profile that names the brand', () => {
        const g = groundFounderName({ firstName: 'Courtney', lastName: 'Despos' }, SKEYO, 'skeyooutdoors.com');
        assert.equal(g.grounded, true);
        assert.deepEqual(g.evidenceIds, [2]);
    });

    it('combines a first name on the store page with the full name elsewhere', () => {
        const results = [SKEYO[0], { title: 'Courtney Despos, PT, DPT', link: 'https://www.linkedin.com/in/x', snippet: 'Physical therapist and entrepreneur' }];
        const g = groundFounderName({ firstName: 'Courtney', lastName: 'Despos' }, results, 'skeyooutdoors.com');
        assert.equal(g.grounded, true);
        assert.deepEqual(g.evidenceIds, [1, 2]);
    });

    it('tolerates a one-letter surname spelling difference', () => {
        assert.equal(groundFounderName({ firstName: 'Jacob', lastName: 'Motzfeldt' }, TRUECO, 'truecompany.com').grounded, true);
    });

    it('requires every word of a multi-word surname', () => {
        const results = [{ title: 'Sorlie Ice Cream', link: 'https://sorlieicecream.com', snippet: 'Founded by Ben Leeuwen' }];
        assert.equal(groundFounderName({ firstName: 'Ben', lastName: 'Van Leeuwen' }, results, 'sorlieicecream.com').grounded, false);
    });

    it('grounds a first-name-only founder on the store page', () => {
        const results = [{ title: 'About Me - Laura Thomas Atelier', link: 'https://laurathomasatelier.com/about', snippet: "Hi I'm Laura, a British artist" }];
        assert.equal(groundFounderName({ firstName: 'Laura', lastName: 'NoLast' }, results, 'laurathomasatelier.com').grounded, true);
    });
});

describe('founderNameFromExtraction', () => {
    it('returns null when not found', () => {
        assert.equal(founderNameFromExtraction({ found: false, first_name: 'Jane' }), null);
    });

    it('uses NoLast when only a first name is known', () => {
        assert.deepEqual(
            founderNameFromExtraction({ found: true, first_name: 'Sarah', last_name: '', role: 'Founder' }),
            { firstName: 'Sarah', lastName: 'NoLast', role: 'Founder' }
        );
    });

    it('rejects handles and honorifics', () => {
        assert.equal(founderNameFromExtraction({ found: true, first_name: '_shafuramalik_', last_name: '' }), null);
        assert.equal(founderNameFromExtraction({ found: true, first_name: 'Dr.', last_name: '' }), null);
        assert.equal(founderNameFromExtraction({ found: true, first_name: 'Jane', last_name: '@janedoe' }), null);
    });

    it('keeps accented and hyphenated names', () => {
        assert.deepEqual(
            founderNameFromExtraction({ found: true, first_name: 'Špela', last_name: 'Jeretina-Novak', role: '' }),
            { firstName: 'Špela', lastName: 'Jeretina-Novak', role: '' }
        );
    });
});

describe('Decisions request/response', () => {
    it('builds one predicate question over the candidate', () => {
        const req = buildDecisionsRequest({ firstName: 'Courtney', lastName: 'Despos', role: 'Founder' }, SKEYO, 'skeyooutdoors.com');
        assert.equal(req.model, 'gpt-6-luna');
        assert.equal(req.questions.length, 1);
        assert.equal(req.questions[0].type, 'predicate');
        assert.match(req.input, /Candidate: Courtney Despos/);
    });

    it('parses a predicate answer and its token usage', () => {
        const parsed = parseDecisionsResponse({
            answers: [{ type: 'predicate', name: DECISIONS_QUESTION, probability: 0.95 }],
            usage: { input_tokens: 299 }
        });
        assert.deepEqual(parsed, { probability: 0.95, refused: false, inputTokens: 299 });
    });

    it('treats a refusal or empty body as no verdict', () => {
        assert.deepEqual(parseDecisionsResponse({ answers: [{ type: 'refusal', name: DECISIONS_QUESTION }] }), { probability: null, refused: true, inputTokens: 0 });
        assert.deepEqual(parseDecisionsResponse(null), { probability: null, refused: false, inputTokens: 0 });
    });
});

describe('founder verification flags', () => {
    it('defaults to Decisions on at 0.5', () => {
        assert.deepEqual(founderVerifyOptionsFromFeatures({}), { decisions: true, minProbability: 0.5 });
        assert.deepEqual(founderVerifyOptionsFromFeatures(null), { decisions: true, minProbability: 0.5 });
    });

    it('honours the off switch and clamps the threshold', () => {
        assert.deepEqual(
            founderVerifyOptionsFromFeatures({ founderDecisionsVerify: false, founderDecisionsThreshold: 1.7 }),
            { decisions: false, minProbability: 1 }
        );
    });

    it('rejects a threshold above 1 in the settings form', () => {
        assert.equal(validateFeaturesPatch({ founderDecisionsThreshold: 1.5 }).ok, false);
        assert.equal(validateFeaturesPatch({ founderDecisionsThreshold: 0.7 }).ok, true);
    });
});
