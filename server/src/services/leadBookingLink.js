/**
 * Link a Calendly booking made with a different email (often a personal Gmail)
 * to the lead it belongs to. As a byproduct the lead gets the "Meeting Booked"
 * timeline event (which also stops follow-ups), the booking lands in the sales
 * log, and Fathom calls recorded with that email are attached and analysed.
 */
import { pool } from '../config/db.js';
import { recordLinkedBookingTimeline } from './calendlyWebhook.js';
import { syncCalendlyBookings } from './db/funnelInputs.js';
import { linkFathomCall } from './callAnalysis/index.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function httpError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function cleanEmail(value, label) {
    const email = String(value || '').trim().toLowerCase();
    if (!email) return null;
    if (!EMAIL_RE.test(email)) throw httpError(`${label} doesn’t look like an email.`);
    return email;
}

async function findLead(clientRow, leadEmail) {
    const { rows: [contact] } = await pool.query(
        `SELECT c.id, c.agency_id, c.client_id, c.full_name, c.email, co.domain_normalized AS domain
         FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
         WHERE c.client_id = $1 AND LOWER(c.email) = $2
         ORDER BY c.last_contacted_at DESC NULLS LAST
         LIMIT 1`,
        [clientRow.id, leadEmail]
    );
    return contact || null;
}

/**
 * An existing hand-made or Fathom-made sales log entry for this lead around the
 * booking time, so linking the booking doesn't add a second row for the call.
 */
async function adoptManualSalesCall({ clientRow, contact, emails, booking }) {
    const start = booking.start_time ? new Date(booking.start_time).getTime() : null;
    const { rows } = await pool.query(
        `SELECT id, call_at FROM sales_calls
         WHERE agency_id = $1 AND client_id = $2 AND calendly_booking_id IS NULL
           AND (contact_id = $3 OR LOWER(contact_email) = ANY($4::text[]))
         ORDER BY created_at DESC`,
        [clientRow.agency_id, clientRow.id, contact.id, emails]
    );
    const match = rows.find((row) => (
        !row.call_at || start === null || Math.abs(new Date(row.call_at).getTime() - start) <= DAY_MS
    ));
    if (!match) return;
    await pool.query(
        'UPDATE sales_calls SET calendly_booking_id = $1, updated_at = NOW() WHERE id = $2',
        [booking.id, match.id]
    );
}

export async function linkCalendlyBookingToLead({ clientRow, leadEmail: rawLead, bookingEmail: rawBooking = null }) {
    const leadEmail = cleanEmail(rawLead, 'Lead email');
    if (!leadEmail) throw httpError('Enter the lead’s email.');
    const bookingEmail = cleanEmail(rawBooking, 'Booking email') || leadEmail;

    const contact = await findLead(clientRow, leadEmail);
    if (!contact) throw httpError(`No lead with the email ${leadEmail} in this client.`, 404);

    const { rows: bookings } = await pool.query(
        `SELECT * FROM calendly_bookings
         WHERE LOWER(invitee_email) = $1
           AND (client_id IS NULL OR (client_id = $2 AND agency_id = $3))
         ORDER BY start_time DESC NULLS LAST`,
        [bookingEmail, clientRow.id, clientRow.agency_id]
    );
    if (!bookings.length) {
        throw httpError(`No Calendly booking from ${bookingEmail} has come in. Check the email they booked with.`, 404);
    }

    const emails = [...new Set([leadEmail, bookingEmail])];
    for (const booking of bookings) {
        await pool.query(
            `UPDATE calendly_bookings
             SET contact_id = $1, agency_id = $2, client_id = $3, updated_at = NOW()
             WHERE id = $4`,
            [contact.id, clientRow.agency_id, clientRow.id, booking.id]
        );
        await recordLinkedBookingTimeline({ booking, contact });
        await adoptManualSalesCall({ clientRow, contact, emails, booking });
    }

    await syncCalendlyBookings(clientRow);
    // Entries copied before the link (no lead yet) now point at the lead.
    await pool.query(
        `UPDATE sales_calls s
         SET contact_id = $1, company = COALESCE(s.company, $2), contact_name = COALESCE(s.contact_name, $3), updated_at = NOW()
         WHERE s.calendly_booking_id = ANY($4::uuid[]) AND s.contact_id IS DISTINCT FROM $1`,
        [contact.id, contact.domain, contact.full_name, bookings.map((b) => b.id)]
    );
    const { rows: salesCalls } = await pool.query(
        `SELECT id, calendly_booking_id, call_at FROM sales_calls
         WHERE calendly_booking_id = ANY($1::uuid[])`,
        [bookings.map((b) => b.id)]
    );

    // Fathom calls recorded with the booking email that never matched anyone.
    const { rows: recordings } = await pool.query(
        `SELECT id, url, share_url, title, recorded_at FROM call_recordings
         WHERE agency_id = $1 AND sales_call_id IS NULL
           AND EXISTS (SELECT 1 FROM unnest(external_emails) e WHERE LOWER(e) = ANY($2::text[]))
         ORDER BY recorded_at DESC`,
        [clientRow.agency_id, emails]
    );
    const fathomCalls = [];
    for (const recording of recordings) {
        const recordedAt = recording.recorded_at ? new Date(recording.recorded_at).getTime() : null;
        const nearest = salesCalls
            .filter((s) => s.call_at)
            .sort((a, b) => Math.abs(new Date(a.call_at) - recordedAt) - Math.abs(new Date(b.call_at) - recordedAt))[0]
            || salesCalls[0];
        try {
            await linkFathomCall({
                agencyId: clientRow.agency_id,
                clientRow,
                url: recording.url || recording.share_url,
                salesCallId: nearest?.id || null,
                leadEmail: nearest ? null : leadEmail
            });
            fathomCalls.push({ id: recording.id, title: recording.title, linked: true });
        } catch (error) {
            fathomCalls.push({ id: recording.id, title: recording.title, linked: false, error: error?.message || String(error) });
        }
    }

    return {
        lead: { id: contact.id, name: contact.full_name, email: contact.email, company: contact.domain },
        bookings: bookings.map((b) => ({ id: b.id, event: b.event_name, startTime: b.start_time, status: b.status })),
        salesCallIds: salesCalls.map((s) => s.id),
        fathomCalls
    };
}
