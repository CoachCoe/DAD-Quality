import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const root of ['src', 'test', 'scripts', 'web']) {
  for (const entry of await readdir(root, { recursive: true })) {
    if (!entry.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', `${root}/${entry}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
