'use strict';
// 아이콘을 코드로 그려요(이미지 파일 없이): 색 원 위에 흰 오름 꺾은선. 색은 봇 상태 —
// 초록=실전 봇이 돎, 파랑=연습만 돎, 회색=다 꺼짐, 주황=멈춘 봇이 있음
const COLORS = { live: [0x1f, 0x9d, 0x55], paper: [0x2f, 0x6f, 0xdb], idle: [0x8a, 0x8f, 0x98], alert: [0xe0, 0x7b, 0x1a] };
const LINE = [[0.25, 0.66], [0.43, 0.47], [0.56, 0.58], [0.76, 0.35]];

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// 미리 곱한(premultiplied) BGRA — Electron nativeImage.createFromBitmap 형식
function bitmap(size, color, { bgra = true } = {}) {
  const [r, g, b] = COLORS[color] || COLORS.idle, px = Buffer.alloc(size * size * 4), c = size / 2, R = size / 2 - 0.5, w = size * 0.085;
  const pts = LINE.map(([x, y]) => [x * size, y * size]);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const cx = x + 0.5, cy = y + 0.5, i = (y * size + x) * 4;
    const disc = Math.max(0, Math.min(1, R - Math.hypot(cx - c, cy - c) + 0.5));
    let d = Infinity; for (let k = 0; k < pts.length - 1; k++) d = Math.min(d, segDist(cx, cy, ...pts[k], ...pts[k + 1]));
    const white = Math.max(0, Math.min(1, w - d + 0.5));
    const cr = r + (255 - r) * white, cg = g + (255 - g) * white, cb = b + (255 - b) * white, a = disc;
    if (bgra) { px[i] = cb * a; px[i + 1] = cg * a; px[i + 2] = cr * a; } else { px[i] = cr * a; px[i + 1] = cg * a; px[i + 2] = cb * a; }
    px[i + 3] = 255 * a;
  }
  return px;
}
function image(nativeImage, color, size = 32, scaleFactor = 2) {
  return nativeImage.createFromBitmap(bitmap(size, color), { width: size, height: size, scaleFactor });
}
// 바로가기(.lnk)는 아이콘을 파일에서 읽어서 .ico도 만들어요 (PNG 한 장짜리 ico)
function icoBuffer(nativeImage, color = 'live', size = 256) {
  const png = nativeImage.createFromBitmap(bitmap(size, color), { width: size, height: size }).toPNG(), head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head[6] = size >= 256 ? 0 : size; head[7] = size >= 256 ? 0 : size; head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}

module.exports = { bitmap, image, icoBuffer, COLORS };
