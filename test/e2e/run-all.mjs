/**
 * 串行跑完所有场景：一个失败不影响其余（最后汇总），退出码非 0 表示有失败。
 *
 * 跑法：npm test        （全部）
 *      npm test -- reset （只跑名字含 reset 的）
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';

const scenarios = readdirSync(HERE)
  .filter((f) => /^run-.+\.mjs$/.test(f) && f !== 'run-all.mjs')
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!scenarios.length) {
  console.error(`没有匹配的场景（filter=${filter}）`);
  process.exit(1);
}

console.log(`\n=== SoilPulse Web E2E：${scenarios.length} 个场景 ===\n`);

const results = [];
for (const file of scenarios) {
  const t0 = Date.now();
  console.log(`\n───── ${file} ─────`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, file)], { stdio: 'inherit' });
    child.on('exit', (c) => resolve(c ?? 1));
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push({ file, code, secs });
}

console.log('\n=== 汇总 ===');
for (const r of results) {
  console.log(`${r.code === 0 ? '✅' : '❌'} ${r.file}  ${r.secs}s`);
}
const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
