#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const envContent = await readFile(join(__dirname, '.env'), 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const match = line.trim().match(/^(\w+)=(.*)$/);
    if (match && match[2] && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
} catch {}

const PORT = parseInt(process.env.PORT || '3388', 10);

async function findListeningPids(port) {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { windowsHide: true });
    const pids = new Set();
    const needle = `:${port}`;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes('LISTENING') || !line.includes(needle)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts.at(-1), 10);
      if (pid > 0) pids.add(pid);
    }
    return [...pids];
  }

  try {
    const { stdout } = await execFileAsync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t']);
    return stdout
      .split(/\r?\n/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => n > 0);
  } catch {
    return [];
  }
}

async function killPid(pid) {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
    return;
  }
  process.kill(pid, 'SIGTERM');
}

async function freePort(port) {
  const pids = await findListeningPids(port);
  for (const pid of pids) {
    if (pid === process.pid) continue;
    console.log(`  ⏹  释放端口 ${port}，结束进程 PID ${pid}`);
    try {
      await killPid(pid);
    } catch (err) {
      console.warn(`  ⚠  无法结束 PID ${pid}: ${err.message}`);
    }
  }
}

await freePort(PORT);

const child = spawn(process.execPath, ['--use-env-proxy', join(__dirname, 'server.mjs')], {
  stdio: 'inherit',
  env: process.env,
  cwd: __dirname,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
