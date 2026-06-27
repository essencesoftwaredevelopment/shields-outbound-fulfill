import { NextResponse } from 'next/server';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * GET /internal/agency/features
 * Returns agency feature flags from Postgres (Vercel preview path).
 *
 * Preview UI proxies /api/* to production Express, which may not yet expose
 * `features` on GET /api/agency/settings. This route reads directly from DB.
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
    const { getAgencySettings, agencyFeaturesFromSettings, hasShoppingAuditFeature } =
      await import('@server/services/db/agencySettings.js');

    const authResult = await resolveAuthFromBearerToken(token);
    const settings = await getAgencySettings(authResult.agencyId);
    const features = agencyFeaturesFromSettings(settings);

    if (process.env.SHOPPING_AUDIT_ENABLED === 'true') {
      features.shoppingAudit = true;
    }

    return NextResponse.json({
      agencyId: authResult.agencyId,
      features,
      shoppingAudit: hasShoppingAuditFeature(settings),
    });
  } catch (error) {
    console.error('[internal/agency/features]', error);
    return NextResponse.json(
      { error: 'Failed to load agency features' },
      { status: 500 }
    );
  }
}
