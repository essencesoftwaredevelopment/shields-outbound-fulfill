/**
 * Normalize domain text for consistent deduping and joins.
 * Canonical form:
 * - lowercase + trimmed
 * - protocol removed (http/https/etc)
 * - path/query/hash removed
 * - trailing dot and port removed
 * - leading "www." removed
 */
export function normalizeDomain(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';

    // If a full email is provided by mistake, use the domain part.
    const emailDomain = raw.includes('@') ? raw.split('@').pop() : raw;

    // Remove scheme/protocol and protocol-relative prefix.
    const withoutScheme = String(emailDomain || '')
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
        .replace(/^\/\//, '');

    // Keep only host-like part before path/query/hash.
    let host = withoutScheme.split(/[/?#]/, 1)[0] || '';
    host = host.replace(/\.$/, ''); // drop trailing dot
    host = host.replace(/:\d+$/, ''); // drop :port
    host = host.trim();

    if (!host) return '';
    return host.startsWith('www.') ? host.slice(4) : host;
}
