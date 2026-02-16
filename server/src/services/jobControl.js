import fs from 'fs';
import path from 'path';
import { TMP_ROOT } from '../config/paths.js';

const DEFAULT_CONTROL = {
    paused: false,
    cancelled: false,
    updatedAt: null
};

function getJobDir(jobId) {
    return path.join(TMP_ROOT, jobId);
}

export function getControlFilePath(jobId) {
    return path.join(getJobDir(jobId), 'control.json');
}

function normalizeControl(raw) {
    return {
        paused: !!raw?.paused,
        cancelled: !!raw?.cancelled,
        updatedAt: raw?.updatedAt || null
    };
}

export function ensureJobControl(jobId, initial = {}) {
    const jobDir = getJobDir(jobId);
    if (!fs.existsSync(jobDir)) {
        fs.mkdirSync(jobDir, { recursive: true });
    }

    const controlPath = getControlFilePath(jobId);
    if (!fs.existsSync(controlPath)) {
        const payload = normalizeControl({ ...DEFAULT_CONTROL, ...initial, updatedAt: new Date().toISOString() });
        fs.writeFileSync(controlPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
        return payload;
    }

    return readJobControl(jobId);
}

export function readJobControl(jobId) {
    const controlPath = getControlFilePath(jobId);
    if (!fs.existsSync(controlPath)) {
        return normalizeControl(DEFAULT_CONTROL);
    }

    try {
        const raw = JSON.parse(fs.readFileSync(controlPath, 'utf-8'));
        return normalizeControl(raw);
    } catch (error) {
        console.warn(`[${jobId}] Failed to read control file:`, error?.message || error);
        return normalizeControl(DEFAULT_CONTROL);
    }
}

export function writeJobControl(jobId, patch = {}) {
    const controlPath = getControlFilePath(jobId);
    const current = ensureJobControl(jobId);
    const next = normalizeControl({
        ...current,
        ...patch,
        updatedAt: new Date().toISOString()
    });

    const tempPath = `${controlPath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    fs.renameSync(tempPath, controlPath);
    return next;
}

