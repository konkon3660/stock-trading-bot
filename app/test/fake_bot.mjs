// 시험용 가짜 봇: 진짜 봇(gap_dip.mjs)처럼 기록 폴더·running.pid·종료 코드 3을 흉내 내요.
// 동작은 orb/fake-<봇>.txt 내용으로: run(계속 돎) / crash(바로 코드 1로 멈춤)
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const has = f => process.argv.includes(f);
const key = has('--hold') ? 'hold' : has('--ah') ? 'ah' : 'gap', live = has('--live');
const dir = join(process.cwd(), 'orb', `data-${key}${live ? '-live' : ''}`); mkdirSync(dir, { recursive: true });
const tag = { gap: '[갭] ', hold: '[보유] ', ah: '[애프터] ' }[key];
const log = m => { const l = `[11-25 10:00:00] ${m}`; console.log(tag + l); appendFileSync(join(dir, 'events.log'), l + '\n'); };
const lock = join(dir, 'running.pid');
try { const old = Number(readFileSync(lock, 'utf8')); if (old && old !== process.pid) { try { process.kill(old, 0); log(`이미 다른 창에서 돌고 있어요(pid ${old})`); process.exit(3); } catch { /* 꺼진 pid */ } } } catch { /* 처음 */ }
writeFileSync(lock, String(process.pid));
const behave = (() => { try { return readFileSync(join(process.cwd(), 'orb', `fake-${key}.txt`), 'utf8').trim(); } catch { return 'run'; } })();
log(`시작 — ${key} ${live ? '⚠ 실전' : '연습'} (${behave})`);
if (behave === 'crash') { console.error('Error: 가짜 오류'); process.exit(1); }
if (behave === 'hold-only') { setInterval(() => {}, 1000); }
else { log('MEDS 실제 매수 체결 10주 $1.00 → 목표 $1.10, 손절 $0.80'); setInterval(() => log('보유 - / 매수 주문 -'), 200); }
