import { runPersonalization as runEcom } from './ecom.js';

// Default to ecom behavior until a dedicated strategy is provided.
export async function runPersonalization(options) {
    return runEcom(options);
}
