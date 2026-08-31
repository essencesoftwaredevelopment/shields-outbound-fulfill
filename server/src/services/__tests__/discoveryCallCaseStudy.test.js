import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CASE_STUDY_FALLBACK_INDUSTRY,
    resolveCaseStudyIndustry
} from '../discoveryCallCaseStudy.js';

test('resolveCaseStudyIndustry: keeps a live industry', () => {
    assert.equal(resolveCaseStudyIndustry('beauty_skincare'), 'beauty_skincare');
    assert.equal(resolveCaseStudyIndustry('Beauty Skincare'), 'beauty_skincare');
    assert.equal(resolveCaseStudyIndustry('food_beverage'), 'food_beverage');
    assert.equal(resolveCaseStudyIndustry('Food Beverage'), 'food_beverage');
    assert.equal(resolveCaseStudyIndustry('electronics'), 'electronics');
    assert.equal(resolveCaseStudyIndustry('Electronics'), 'electronics');
});

test('resolveCaseStudyIndustry: maps stub industries to fashion fallback', () => {
    assert.equal(resolveCaseStudyIndustry('pets'), CASE_STUDY_FALLBACK_INDUSTRY);
    assert.equal(resolveCaseStudyIndustry('fashion_apparel'), CASE_STUDY_FALLBACK_INDUSTRY);
});

test('resolveCaseStudyIndustry: maps unrouted research industries to fashion fallback', () => {
    assert.equal(resolveCaseStudyIndustry('home_garden'), CASE_STUDY_FALLBACK_INDUSTRY);
    assert.equal(resolveCaseStudyIndustry('automotive'), CASE_STUDY_FALLBACK_INDUSTRY);
    assert.equal(resolveCaseStudyIndustry('sports_outdoors'), CASE_STUDY_FALLBACK_INDUSTRY);
    assert.equal(resolveCaseStudyIndustry('kids_baby'), CASE_STUDY_FALLBACK_INDUSTRY);
});

test('resolveCaseStudyIndustry: missing or unknown still gets the fashion fallback', () => {
    assert.equal(resolveCaseStudyIndustry(null), CASE_STUDY_FALLBACK_INDUSTRY);
    assert.equal(resolveCaseStudyIndustry(''), CASE_STUDY_FALLBACK_INDUSTRY);
    assert.equal(resolveCaseStudyIndustry('saas'), CASE_STUDY_FALLBACK_INDUSTRY);
});
