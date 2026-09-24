import { NextResponse } from 'next/server';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * GET /internal/agency/credits[?refresh=1]
 * Cached TryKitt / Enrow credits row for the caller's agency (Pipeline tab),
 * refreshed first when stale or requested. Later changes arrive over Realtime
 * on agency_provider_credits. Served by Next so it ships with the UI instead of
 * waiting on an Express deploy.
 */
export async function GET(request: Request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    return unauthorized();
  }

  try {
    const { resolveAuthFromBearerToken } = await import(
      '@server/utils/authCache.js'
    );
    const { getAgencyProviderCredits } = await import(
      '@server/services/providerCredits.js'
    );

    const authResult = await resolveAuthFromBearerToken(token);
    const force = new URL(request.url).searchParams.get('refresh') === '1';
    const row = await getAgencyProviderCredits(authResult.agencyId, { force });
    return NextResponse.json({ agencyId: authResult.agencyId, row });
  } catch (error) {
    console.error('[internal/agency/credits]', error);
    return NextResponse.json(
      { error: 'Failed to load provider credits' },
      { status: 500 }
    );
  }
}
