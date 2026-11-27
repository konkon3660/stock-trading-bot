'use strict';
// 봇 리그 탭 데이터: history/mine/league_sim.py가 만든 orb/league/league.json을 읽기만 해요.
const fs = require('node:fs');
const path = require('node:path');

function readLeague(root) {
  const file = path.join(root, 'orb', 'league', 'league.json');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { ok: false, reason: e.code === 'ENOENT' ? '아직 리그 기록이 없어요 (history/mine/league_sim.py를 한 번 돌려 주세요)' : `리그 기록을 못 읽었어요: ${e.message}` }; }
  if (!Array.isArray(doc?.bots) || !doc.bots.length || !doc.bots[0].daily?.length) return { ok: false, reason: '리그 기록 모양이 이상해요' };
  return { ok: true, doc };
}

module.exports = { readLeague };
