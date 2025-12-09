import { runPersonalization as runEcom } from './strategies/ecom.js';
import { runPersonalization as runSaas } from './strategies/saas.js';
import { runPersonalization as runAgency } from './strategies/agency.js';
import { runPersonalization as runLocal } from './strategies/local.js';
import { runPersonalization as runDefault } from './strategies/default.js';

const strategies = {
    ecom: runEcom,
    saas: runSaas,
    agency: runAgency,
    local: runLocal,
};

export function runPersonalization(options) {
    const key = (options.industry || options.nicheId || '').toLowerCase();
    const handler = strategies[key] || runDefault;
    return handler(options);
}
