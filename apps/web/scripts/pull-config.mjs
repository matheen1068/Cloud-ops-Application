// Writes public/config.json from the deployed stack's outputs, for local dev.
// Usage: npm run config -w @cloud-ops/web            (stack CloudOps-dev)
//        npm run config -w @cloud-ops/web -- CloudOps-prod
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const stack = process.argv[2] ?? 'CloudOps-dev';
const raw = execFileSync(
  'aws',
  ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', 'Stacks[0].Outputs', '--output', 'json'],
  { encoding: 'utf8' },
);
const outputs = Object.fromEntries(JSON.parse(raw).map((o) => [o.OutputKey, o.OutputValue]));

const config = {
  apiUrl: outputs.ApiUrl,
  region: outputs.Region,
  userPoolId: outputs.UserPoolId,
  userPoolClientId: outputs.UserPoolClientId,
};
if (Object.values(config).some((v) => !v)) {
  console.error(`Stack ${stack} is missing outputs. Deploy it first.`, outputs);
  process.exit(1);
}

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'config.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log(`Wrote ${file} from ${stack}`);
