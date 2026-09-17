import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rowToJobState, type JobRealtimeRow } from '../realtimeRow.ts';

const fullRow: JobRealtimeRow = {
  id: 'job-1',
  status: 'running',
  paused: false,
  cancelled: false,
  stages: { founders: { status: 'completed' } },
  options: {
    skipFounderFinder: true,
    skipEmailFinder: true,
    skipVerification: true,
    personalizeFirstLine: true,
    pipelineMode: 'shopping_audit',
    activityMessage: 'Importing emails from CSV (100)…',
  },
  dedupe_stats: { existing: 2407, new: 0 },
  error: null,
  cost: 0.5,
  file_name: 'leads.csv',
  updated_at: '2026-09-17T18:50:32.000Z',
};

describe('rowToJobState', () => {
  it('maps a full row, including option-derived skip flags', () => {
    const state = rowToJobState(fullRow);
    assert.equal(state.skipFounderFinder, true);
    assert.equal(state.skipEmailFinder, true);
    assert.equal(state.skipVerification, true);
    assert.equal(state.personalizeFirstLine, true);
    assert.equal(state.pipelineMode, 'shopping_audit');
    assert.equal(state.activityMessage, 'Importing emails from CSV (100)…');
    assert.deepEqual(state.stages, fullRow.stages);
    assert.deepEqual(state.dedupeStats, fullRow.dedupe_stats);
  });

  it('omits option-derived fields when the payload has no `options` (unchanged TOAST column on a heartbeat UPDATE)', () => {
    // Supabase Realtime leaves unchanged TOASTed JSONB out of UPDATE payloads
    // unless the table has REPLICA IDENTITY FULL. Defaulting the flags to false
    // here is what made the hidden Founder/Email cards flicker in.
    const { options: _options, stages: _stages, dedupe_stats: _dedupe, ...heartbeat } = fullRow;
    const state = rowToJobState(heartbeat);
    for (const key of ['skipFounderFinder', 'skipEmailFinder', 'skipVerification', 'personalizeFirstLine', 'pipelineMode', 'activityMessage', 'stages', 'dedupeStats']) {
      assert.equal(key in state, false, `${key} should be absent so the page merge keeps the previous value`);
    }
    assert.equal(state.status, 'running');
    assert.equal(state.id, 'job-1');
  });

  it('still emits explicit falsy values when the columns are present but empty', () => {
    const state = rowToJobState({ ...fullRow, options: {}, stages: null, dedupe_stats: null });
    assert.equal(state.skipEmailFinder, false);
    assert.equal(state.pipelineMode, 'standard');
    assert.deepEqual(state.stages, {});
    assert.equal(state.dedupeStats, null);
  });
});
