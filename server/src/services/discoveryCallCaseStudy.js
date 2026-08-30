/**
 * Industry routing for the Discovery Pre Call case-study email (email 3).
 *
 * Only industries in CASE_STUDY_LIVE_INDUSTRIES have a real case-study
 * template. Everything else — missing brief, unknown vertical, or a slug
 * whose template is still a stub — maps to fashion_apparel (Spicy Wear).
 * Add a slug here when that Resend template is published with real copy.
 */

import { normalizeResearchIndustry } from './interestedResearch/briefUtils.js';

export const CASE_STUDY_INDUSTRIES = Object.freeze([
    'beauty_skincare',
    'fashion_apparel',
    'food_beverage',
    'health_wellness',
    'electronics',
    'pets',
    'jewelry_accessories',
    'gifts_collectibles'
]);

export const CASE_STUDY_FALLBACK_INDUSTRY = 'fashion_apparel';

/** Templates that currently have real case-study copy, not Aer stubs. */
export const CASE_STUDY_LIVE_INDUSTRIES = Object.freeze([
    'beauty_skincare',
    'food_beverage'
]);

export const CASE_STUDY_TEMPLATES = Object.freeze({
    beauty_skincare: 'case-study-beauty-skincare',
    fashion_apparel: 'case-study-fashion-apparel',
    food_beverage: 'case-study-food-beverage',
    health_wellness: 'case-study-health-wellness',
    electronics: 'case-study-electronics',
    pets: 'case-study-pets',
    jewelry_accessories: 'case-study-jewelry-accessories',
    gifts_collectibles: 'case-study-gifts-collectibles'
});

const LIVE_INDUSTRY_SET = new Set(CASE_STUDY_LIVE_INDUSTRIES);

/**
 * Always returns a code the automation can send a real case study for.
 * Beauty → Aer. Food → Linear Bar. Anything else, including missing, → Spicy Wear.
 */
export function resolveCaseStudyIndustry(raw) {
    const normalized = normalizeResearchIndustry(raw);
    if (normalized && LIVE_INDUSTRY_SET.has(normalized)) return normalized;
    return CASE_STUDY_FALLBACK_INDUSTRY;
}
