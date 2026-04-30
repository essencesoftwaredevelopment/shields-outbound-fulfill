export async function runSmallTask(input = {}) {
    const startedAt = Date.now();
    const dryRun = Boolean(input.dryRun);
    const name = String(input.name || 'default-task').trim();

    // Simulate lightweight script logic that can be extended later.
    const summary = {
        name,
        dryRun,
        message: dryRun
            ? 'Dry run completed. No data changes were made.'
            : 'Script completed successfully.',
        executedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt
    };

    return summary;
}