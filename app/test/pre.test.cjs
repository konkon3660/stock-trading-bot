'use strict';
// 프리장 연습 봇(gap_dip.mjs --pre) 가상 시장 하루: 목표·손절·9:25 정리·9:00 취소가 맞게 나오고, 가격대 밖·레버리지 ETF는 신호가 안 됨
// 실행: node app/test/pre.test.cjs
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..', '..');
execFileSync(process.execPath, ['orb/gap_dip.mjs', '--pre', '--mock'], { cwd: root, stdio: 'ignore', timeout: 120_000 });
const lines = fs.readFileSync(path.join(root, 'orb', 'data-pre-mock', 'trades.csv'), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
const head = lines[0].split(','), col = name => head.indexOf(name);
const rows = Object.fromEntries(lines.slice(1).map(l => l.split(',')).map(c => [c[col('종목')], c]));
const reason = s => rows[s]?.[col('청산사유')];
assert.deepEqual(['PRW', 'PRL', 'PRT', 'PRN'].map(reason), ['목표', '손절', '9:25 정리', '9:00까지 안 닿음']);
assert.ok(Number(rows.PRW[col('손익USD')]) > 0 && Number(rows.PRL[col('손익USD')]) < 0);
assert.equal(rows.PRN[col('손익USD')], '', '안 닿은 신호는 손익 없음');
assert.ok(!rows.PRX && !rows.LEV3, '가격대 밖·레버리지 ETF는 신호 안 됨');
// 원자료: 신호 종목마다 4:00~9:25 1분봉, 5분마다 호가
const rec = path.join(root, 'orb', 'data-pre-mock', 'rec', rows.PRW[col('날짜(ET)')]);
const prw = JSON.parse(fs.readFileSync(path.join(rec, 'PRW.json'), 'utf8'));
assert.equal(prw.pc, 2); assert.ok(prw.bars.length >= 320, `1분봉 ${prw.bars.length}개`);
const books = fs.readFileSync(path.join(rec, '_books.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
assert.ok(books.filter(b => b.s === 'PRN').length >= 50, '안 닿은 종목도 9:25까지 호가를 남김');
console.log('ALL OK');
