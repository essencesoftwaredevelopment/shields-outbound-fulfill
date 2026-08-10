import { NextResponse } from 'next/server';

// Brief synthesis is one OpenAI call (~20s typical); leave generous headroom.
export const maxDuration = 120;

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * POST /internal/interested-research/test
 * Body: { domain, agencyId?, company? }
 * Auth: Bearer WORKFLOW_TRIGGER_SECRET (same as the other internal routes).
 *
 * Dry run of the interested-research pipeline for one domain: homepage fetch →
 * Serper sweep → brief synthesis, using the agency's real keys. Returns the
 * brief and the popup-form payload that WOULD be sent. Writes nothing: no
 * draft rows, no popup API call, no workflow run. Postman/curl-friendly
 * counterpart of server/src/scripts/test-interested-research.js.
 *
 * Cost per call: one Serper request + one OpenAI request on the agency's keys.
 */
export async function POST(request: Request) {
  const secret = process.env.WORKFLOW_TRIGGER_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== secret) {
      return unauthorized();
    }
  }

  let body: { domain?: string; agencyId?: string; company?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const [research, autoresponder, agencySettingsDb, db] = await Promise.all([
    import('@server/services/interestedResearch/index.js'),
    import('@server/services/interestedAutoResponder.js'),
    import('@server/services/db/agencySettings.js'),
    import('@server/config/db.js'),
  ]);

  const domain = autoresponder.normalizeAuditDomain(body.domain);
  if (!domain) {
    return NextResponse.json(
      { error: 'A valid domain is required (e.g. "wildorchard.com").' },
      { status: 400 }
    );
  }

  let agencyId = String(body.agencyId || '').trim();
  if (!agencyId) {
    const result = await db.pool.query(
      `SELECT agency_id
       FROM agency_settings
       WHERE COALESCE(serper_key, '') <> '' AND COALESCE(openai_key, '') <> ''
       ORDER BY agency_id
       LIMIT 1`
    );
    agencyId = result.rows[0]?.agency_id || '';
  }
  if (!agencyId) {
    return NextResponse.json(
      { error: 'No agency with both Serper and OpenAI keys found — pass agencyId.' },
      { status: 400 }
    );
  }

  const settings = await agencySettingsDb.getAgencySettings(agencyId);
  const keys = agencySettingsDb.apiKeysFromSettings(settings);
  if (!keys.serper || !keys.openai) {
    return NextResponse.json(
      { error: `Agency ${agencyId} is missing a ${keys.serper ? 'OpenAI' : 'Serper'} key.` },
      { status: 400 }
    );
  }

  const companyName = String(body.company || '').trim()
    || autoresponder.humanizeDomainAsCompanyName(domain);

  const researchStarted = Date.now();
  const [homepage, serper] = await Promise.all([
    research.fetchHomepageForDomain(domain),
    research.fetchSerperForTarget({ companyName, domain, serperKey: keys.serper }),
  ]);
  const researchMs = Date.now() - researchStarted;

  const briefStarted = Date.now();
  const brief = await research.synthesizeBriefFromContext({
    openaiKey: keys.openai,
    companyName,
    domain,
    homepage,
    serper,
  });
  const briefMs = Date.now() - briefStarted;

  const popupPayload = brief
    ? {
        domain,
        ...(brief.industry ? { industry: brief.industry } : {}),
        ...(brief.company ? { companyName: brief.company } : {}),
        ...(brief.summary ? { summary: brief.summary } : {}),
        ...(brief.talkingPoints?.length ? { talkingPoints: brief.talkingPoints } : {}),
      }
    : { domain };

  return NextResponse.json({
    domain,
    companyName,
    agencyId,
    timings: { researchMs, briefMs },
    homepage: homepage
      ? {
          url: homepage.url,
          title: homepage.title,
          description: homepage.description,
          textChars: homepage.text.length,
        }
      : null,
    serper: serper
      ? { resultCount: serper.results.length, results: serper.results }
      : null,
    brief,
    popupPayload,
    note: 'Dry run — nothing was written and the popup API was NOT called.',
  });
}
