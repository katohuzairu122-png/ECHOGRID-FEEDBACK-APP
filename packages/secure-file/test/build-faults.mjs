import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
// Explicit builds only; no install hooks or production fault switches.
const root = fileURLToPath(new URL('../', import.meta.url));
let result;
if (process.platform === 'win32') {
  const gyp = createRequire(import.meta.url).resolve('node-gyp/bin/node-gyp.js');
  result = spawnSync(process.execPath, [gyp, 'rebuild', '--directory', 'test/windows-faults'], { cwd: root, stdio: 'inherit' });
  if (result.status === 0) copyFileSync(resolve(root, 'test/windows-faults/build/Release/secure_file_faults.node'), resolve(root, 'build/Release/secure_file_faults.node'));
} else {
  if (process.platform !== 'linux' || !process.env.NODE_INCLUDE_DIR) throw new Error('Linux and NODE_INCLUDE_DIR required');
  const args = ['-shared', '-fPIC', '-Wall', '-Wextra', '-Werror', '-DNAPI_VERSION=9',
    '-I', process.env.NODE_INCLUDE_DIR, 'test/faults/addon.c', 'test/faults/posix.c',
    '-o', resolve(root, 'build/Release/secure_file_faults.node')];
  result = spawnSync('cc', args, { cwd: root, stdio: 'inherit' });
}
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

if (result.status === 0) {
  const wrapper = readFileSync(resolve(root, 'index.js'), 'utf8').replace('./build/Release/secure_file.node', './secure_file_faults.node');
  writeFileSync(resolve(root, 'build/Release/fault-wrapper.mjs'), wrapper);
}
