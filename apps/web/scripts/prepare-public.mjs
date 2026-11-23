// Copies the onboarding template into public/ so the Connect Account page can offer it
// as a download (same file locally and on CloudFront). Runs before dev and build.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '..', '..', 'onboarding', 'cloudformation', 'cloudops-access-role.yaml');
const target = join(root, 'public', 'onboarding', 'cloudops-access-role.yaml');

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
