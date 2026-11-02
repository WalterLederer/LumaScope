import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const buildDirectory = join(scriptDirectory, 'build');
const executablePath = join(buildDirectory, 'Release', 'jxr-wic-encoder.exe');

if (process.platform !== 'win32') {
  console.info('[JXR WIC] Skipping native encoder build: JPEG XR capture is Windows-only.');
  process.exit(0);
}

mkdirSync(buildDirectory, { recursive: true });

const run = (command, args) => {
  const commandLine = [command, ...args].map(value => JSON.stringify(value)).join(' ');
  const startedAt = Date.now();
  console.info(`[ExternalProcess] START ${commandLine}`);
  const result = spawnSync(command, args, { cwd: scriptDirectory, stdio: 'inherit', windowsHide: true });
  const duration = Date.now() - startedAt;
  if (result.error) {
    console.error(`[ExternalProcess] FAILED duration=${duration}ms command=${commandLine}`, result.error);
    throw result.error;
  }
  console.info(`[ExternalProcess] EXIT code=${result.status ?? 'unknown'} duration=${duration}ms command=${commandLine}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`);
  }
};

run('cmake', ['-S', '.', '-B', 'build', '-A', 'x64']);
run('cmake', ['--build', 'build', '--config', 'Release']);

if (!existsSync(executablePath)) {
  throw new Error(`CMake completed but the WIC encoder executable was not found: ${executablePath}`);
}

console.info(`[JXR WIC] Encoder ready: ${executablePath}`);
