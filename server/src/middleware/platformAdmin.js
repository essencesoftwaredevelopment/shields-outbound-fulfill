import { env } from '../config/env.js';

function parseAdminEmails() {
    return new Set(
        String(env.PLATFORM_ADMIN_EMAILS || '')
            .split(',')
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean)
    );
}

export function isPlatformAdminEmail(email) {
    if (!email) return false;
    const admins = parseAdminEmails();
    if (admins.size === 0) return false;
    return admins.has(String(email).trim().toLowerCase());
}

export function requirePlatformAdmin(req, res, next) {
    if (!isPlatformAdminEmail(req.auth?.email)) {
        return res.status(403).json({ error: 'Platform admin access required' });
    }
    next();
}
