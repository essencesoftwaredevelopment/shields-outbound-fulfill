import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TMP_ROOT = path.join(__dirname, '..', '..', 'tmp', 'jobs');
