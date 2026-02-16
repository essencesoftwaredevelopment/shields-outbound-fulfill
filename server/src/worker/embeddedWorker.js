import path from 'path';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_CWD = path.resolve(__dirname, '../..');

export function startEmbeddedQueueWorker(options = {}) {
    const enabled = options.enabled !== false;
    if (!enabled) {
        console.log('[queue] Embedded worker disabled');
        return null;
    }

    const workerPath = path.join(__dirname, 'queueWorker.js');
    let child = null;
    let stopping = false;

    const spawn = () => {
        child = fork(workerPath, [], {
            stdio: 'inherit',
            cwd: SERVER_CWD,
            env: {
                ...process.env,
                QUEUE_WORKER_EMBEDDED: '1'
            }
        });

        console.log(`[queue] Embedded worker started (pid ${child.pid})`);

        child.on('exit', (code, signal) => {
            if (stopping) {
                console.log('[queue] Embedded worker stopped');
                return;
            }

            console.error(`[queue] Embedded worker exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}), restarting`);
            setTimeout(spawn, 1000);
        });

        child.on('error', (err) => {
            if (!stopping) {
                console.error('[queue] Embedded worker error:', err?.message || err);
            }
        });
    };

    spawn();

    return {
        stop() {
            stopping = true;
            if (child && !child.killed) {
                child.kill('SIGTERM');
            }
        }
    };
}
