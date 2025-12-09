import fs from 'fs';
import { parse as csvParse } from 'csv-parse';
import { VALID_UPLOAD_STATUSES } from './constants.js';

export async function readCsvToArray(filePath) {
    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csvParse({ columns: true, skip_empty_lines: true, trim: true }))
            .on('data', (row) => rows.push(row))
            .on('end', resolve)
            .on('error', reject);
    });
    return rows;
}

export async function buildFoundersCsvFromInput({ filteredDomainsPath, originalInputPath, outputPath }) {
    const domainSet = new Set();
    await new Promise((resolve, reject) => {
        fs.createReadStream(filteredDomainsPath)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', row => {
                const domain = String(row.domain || '').toLowerCase();
                if (domain) domainSet.add(domain);
            })
            .on('end', resolve)
            .on('error', reject);
    });

    const domainToFounder = new Map();
    await new Promise((resolve, reject) => {
        fs.createReadStream(originalInputPath)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', row => {
                const domain = String(row.domain || '').toLowerCase();
                const founder = String(row.founder_name || row.founder || '').trim();
                if (domain) domainToFounder.set(domain, founder);
            })
            .on('end', resolve)
            .on('error', reject);
    });

    const writer = fs.createWriteStream(outputPath);
    writer.write('domain,founder_name\n');
    domainSet.forEach(domain => {
        const name = (domainToFounder.get(domain) || '').replace(/"/g, '""');
        writer.write(`${domain},"${name}"\n`);
    });
    writer.end();
    await new Promise(resolve => writer.on('finish', resolve));
}

export async function buildUnifiedRows({ jobId, scope = 'all', resolveJobPaths }) {
    if (typeof resolveJobPaths !== 'function') {
        throw new Error('resolveJobPaths is required to build unified rows');
    }
    const { finalPath, personalizedPath } = resolveJobPaths(jobId);
    if (!fs.existsSync(finalPath)) {
        return [];
    }

    const finalRows = await readCsvToArray(finalPath);

    const personalizedByDomain = new Map();
    if (fs.existsSync(personalizedPath)) {
        const personalizedRows = await readCsvToArray(personalizedPath);
        personalizedRows.forEach((row) => {
            const domainKey = String(row.domain || '').toLowerCase();
            if (domainKey) personalizedByDomain.set(domainKey, row);
        });
    }

    const unified = finalRows.map((r) => {
        const domainKey = String(r.domain || '').toLowerCase();
        const founder = String(r.founder_name || '').trim();
        const parts = founder.split(/\s+/);
        const first_name = parts[0] || '';
        const last_name = parts.length > 1 ? parts.slice(1).join(' ') : '';
        const personal = personalizedByDomain.get(domainKey) || {};
        return {
            domain: r.domain || '',
            founder_name: r.founder_name || '',
            email: r.email || '',
            email_status: r.email_status || r.lookup_status || '',
            first_name,
            last_name,
            personalization: personal.first_line || personal.personalization_first_line || '',
            personalization_first_line: personal.first_line || personal.personalization_first_line || '',
            personalization_title: personal.title || personal.personalization_title || '',
            personalization_url: personal.url || personal.personalization_url || '',
            product_title: personal.title || personal.personalization_title || ''
        };
    });

    if (scope === 'valid') {
        return unified.filter(r => VALID_UPLOAD_STATUSES.has((r.email_status || '').toLowerCase()));
    }

    return unified;
}

export async function writeUploadCsv(filePath, rows) {
    if (!rows || !Array.isArray(rows)) return;
    const headers = ['domain', 'founder_name', 'email', 'email_status', 'first_name', 'last_name', 'personalization', 'personalization_first_line', 'personalization_title', 'personalization_url', 'product_title'];
    const writer = fs.createWriteStream(filePath);
    writer.write(headers.join(',') + '\n');
    rows.forEach((row) => {
        const line = headers.map((key) => {
            const value = row[key] ?? '';
            const safe = String(value).replace(/"/g, '""');
            return `"${safe}"`;
        }).join(',');
        writer.write(line + '\n');
    });
    writer.end();
    await new Promise(resolve => writer.on('finish', resolve));
}
