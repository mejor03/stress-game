// 건물 붕괴 시뮬레이션 (렌더링과 분리된 순수 로직)
// 셀 상태: 0 없음, 1 고정(건물), 2 낙하 덩어리(클러스터), 3 잔해(움직임), 4 잔해(정지)

export const ITEMS = [
  { name: '볼링공', count: 3, r: 1.6, budget: 14, blast: 6.0, desc: '가볍고 개수가 많음' },
  { name: '철구', count: 1, r: 3.0, budget: 80, blast: 10.5, desc: '최강 파괴력, 단 1개' },
  { name: '냉장고', count: 2, r: 2.3, budget: 32, blast: 8.0, desc: '넓게 부숨' },
  { name: '자동차', count: 1, r: 2.9, budget: 55, blast: 10.0, desc: '크고 묵직함' },
  { name: '수박', count: 5, r: 1.4, budget: 2, blast: 3.2, splat: true, desc: '부수진 못해도 속은 시원' },
  { name: '모루', count: 2, r: 1.8, budget: 40, blast: 5.0, desc: '깊게 뚫고 들어감' },
];

const G = 9.8;
const rand = (a, b) => a + Math.random() * (b - a);

function qMulAxis(q, wx, wy, wz, dt) {
  // q <- q + 0.5 * (w,0) * q * dt, 정규화
  const [x, y, z, w] = q;
  const hx = 0.5 * dt * wx, hy = 0.5 * dt * wy, hz = 0.5 * dt * wz;
  const nx = x + (hx * w + hy * z - hz * y);
  const ny = y + (hy * w + hz * x - hx * z);
  const nz = z + (hz * w + hx * y - hy * x);
  const nw = w + (-hx * x - hy * y - hz * z);
  const l = Math.hypot(nx, ny, nz, nw) || 1;
  q[0] = nx / l; q[1] = ny / l; q[2] = nz / l; q[3] = nw / l;
}
function qRot(q, vx, vy, vz, out) {
  const [x, y, z, w] = q;
  const ix = w * vx + y * vz - z * vy;
  const iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx;
  const iw = -x * vx - y * vy - z * vz;
  out[0] = ix * w + iw * -x + iy * -z - iz * -y;
  out[1] = iy * w + iw * -y + iz * -x - ix * -z;
  out[2] = iz * w + iw * -z + ix * -y - iy * -x;
  return out;
}

export class Sim {
  constructor(geo, mask) {
    const { nx, ny, nz, cw, ch, cd } = geo;
    Object.assign(this, { nx, ny, nz, cw, ch, cd });
    const N = (this.N = nx * ny * nz);
    this.x0 = (-nx * cw) / 2; this.z0 = (-nz * cd) / 2;
    this.W = nx * cw; this.D = nz * cd; this.H = ny * ch;
    this.state = new Uint8Array(N);
    this.faces = new Float32Array(N); // 외벽 면 비트: +z,-z,+x,-x,+y
    this.pos = new Float32Array(N * 3);
    this.quat = new Float32Array(N * 4);
    this.vel = new Float32Array(N * 3);
    this.ang = new Float32Array(N * 3);
    this.scale = new Float32Array(N);
    this.awake = new Float32Array(N); // 잔해 움직인 시간
    this.dirty = new Uint8Array(N);
    this.dirtyList = [];
    this.layerOrig = new Int32Array(ny);
    this.total = 0;
    const has = (ix, iy, iz) =>
      ix >= 0 && iy >= 0 && iz >= 0 && ix < nx && iy < ny && iz < nz && mask(ix, iy, iz);
    for (let iy = 0; iy < ny; iy++)
      for (let iz = 0; iz < nz; iz++)
        for (let ix = 0; ix < nx; ix++) {
          const i = this.idx(ix, iy, iz);
          this.quat[i * 4 + 3] = 1;
          const [hx, hy, hz] = this.home(ix, iy, iz);
          this.pos[i * 3] = hx; this.pos[i * 3 + 1] = hy; this.pos[i * 3 + 2] = hz;
          if (!has(ix, iy, iz)) { this.scale[i] = 0; continue; }
          this.state[i] = 1; this.scale[i] = 1; this.total++; this.layerOrig[iy]++;
          let f = 0;
          if (!has(ix, iy, iz + 1)) f |= 1;
          if (!has(ix, iy, iz - 1)) f |= 2;
          if (!has(ix + 1, iy, iz)) f |= 4;
          if (!has(ix - 1, iy, iz)) f |= 8;
          if (!has(ix, iy + 1, iz)) f |= 16;
          this.faces[i] = f;
        }
    this.staticCount = this.total;
    this.clusters = [];
    this.projectiles = [];
    this.events = [];
    this.structDirty = false;
    this.wakeCols = new Set();
    // 잔해 더미 높이맵
    this.pRes = 2.5; this.pN = 160; this.pOff = (this.pN * this.pRes) / 2;
    this.pile = new Float32Array(this.pN * this.pN);
    this._t = [0, 0, 0];
  }
  idx(ix, iy, iz) { return ix + this.nx * (iz + this.nz * iy); }
  coords(i) {
    const ix = i % this.nx, r = (i / this.nx) | 0, iz = r % this.nz, iy = (r / this.nz) | 0;
    return [ix, iy, iz];
  }
  home(ix, iy, iz) {
    return [this.x0 + (ix + 0.5) * this.cw, (iy + 0.5) * this.ch, this.z0 + (iz + 0.5) * this.cd];
  }
  cellAt(x, y, z) {
    const ix = Math.floor((x - this.x0) / this.cw), iy = Math.floor(y / this.ch), iz = Math.floor((z - this.z0) / this.cd);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.nx || iy >= this.ny || iz >= this.nz) return -1;
    return this.idx(ix, iy, iz);
  }
  isSolid(x, y, z) { const c = this.cellAt(x, y, z); return c >= 0 && this.state[c] === 1; }
  mark(i) { if (!this.dirty[i]) { this.dirty[i] = 1; this.dirtyList.push(i); } }
  takeDirty() { const l = this.dirtyList; this.dirtyList = []; for (const i of l) this.dirty[i] = 0; return l; }
  destroyed() { return 1 - this.staticCount / this.total; }

  pileIdx(x, z) {
    const a = Math.floor((x + this.pOff) / this.pRes), b = Math.floor((z + this.pOff) / this.pRes);
    if (a < 0 || b < 0 || a >= this.pN || b >= this.pN) return -1;
    return a + b * this.pN;
  }
  pileAt(x, z) { const k = this.pileIdx(x, z); return k < 0 ? 0 : this.pile[k]; }
  pileAdd(x, z, top) {
    const k = this.pileIdx(x, z); if (k < 0) return;
    const h = Math.min(26, top);
    const n = this.pN;
    const set = (kk, v) => { if (kk >= 0 && kk < this.pile.length && this.pile[kk] < v) this.pile[kk] = v; };
    set(k, h);
    set(k - 1, h * 0.7); set(k + 1, h * 0.7); set(k - n, h * 0.7); set(k + n, h * 0.7);
  }

  leaveStatic(i) {
    if (this.state[i] === 1) {
      this.staticCount--;
      const [ix, , iz] = this.coords(i);
      this.wakeCols.add(ix + iz * this.nx);
      this.structDirty = true;
    }
  }
  toDebris(i, vx, vy, vz) {
    this.leaveStatic(i);
    this.state[i] = 3;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    const s = Math.hypot(vx, vy, vz) * 0.08 + 0.6;
    this.ang[i * 3] = rand(-s, s); this.ang[i * 3 + 1] = rand(-s, s); this.ang[i * 3 + 2] = rand(-s, s);
    if (this.scale[i] >= 1) this.scale[i] = rand(0.68, 0.92);
    this.awake[i] = 0;
    this.mark(i);
  }

  throwItem(item, p, v) {
    const sp = Math.hypot(v[0], v[1], v[2]);
    const b0 = Math.max(1, Math.round(item.budget * Math.min(1.5, Math.max(0.6, (sp / 78) ** 2))));
    const pr = { item, p: [...p], v: [...v], b0, budget: b0, t: 0, done: false, landed: 0, rot: 0 };
    this.projectiles.push(pr);
    return pr;
  }

  // 투사체가 건물과 닿는지 (구-상자 거리)
  touching(p, r) {
    const { cw, ch, cd } = this;
    const ix0 = Math.floor((p[0] - r - this.x0) / cw), ix1 = Math.floor((p[0] + r - this.x0) / cw);
    const iy0 = Math.floor((p[1] - r) / ch), iy1 = Math.floor((p[1] + r) / ch);
    const iz0 = Math.floor((p[2] - r - this.z0) / cd), iz1 = Math.floor((p[2] + r - this.z0) / cd);
    for (let iy = Math.max(0, iy0); iy <= Math.min(this.ny - 1, iy1); iy++)
      for (let iz = Math.max(0, iz0); iz <= Math.min(this.nz - 1, iz1); iz++)
        for (let ix = Math.max(0, ix0); ix <= Math.min(this.nx - 1, ix1); ix++) {
          const i = this.idx(ix, iy, iz);
          if (this.state[i] !== 1) continue;
          const [hx, hy, hz] = this.home(ix, iy, iz);
          const dx = Math.max(Math.abs(p[0] - hx) - cw / 2, 0);
          const dy = Math.max(Math.abs(p[1] - hy) - ch / 2, 0);
          const dz = Math.max(Math.abs(p[2] - hz) - cd / 2, 0);
          if (dx * dx + dy * dy + dz * dz < r * r) return true;
        }
    return false;
  }

  impact(pr) {
    const { p, v, item } = pr;
    const sp = Math.hypot(v[0], v[1], v[2]) || 1;
    const dir = [v[0] / sp, v[1] / sp, v[2] / sp];
    // 충격 지점을 진행 방향으로 살짝 앞당겨서 폭발 범위 계산
    const ahead = item.blast * 0.5;
    const c = [p[0] + dir[0] * ahead, p[1] + dir[1] * ahead, p[2] + dir[2] * ahead];
    const R = item.blast, cand = [];
    const { cw, ch, cd } = this;
    for (let iy = Math.max(0, Math.floor((c[1] - R) / ch)); iy <= Math.min(this.ny - 1, Math.floor((c[1] + R) / ch)); iy++)
      for (let iz = Math.max(0, Math.floor((c[2] - R - this.z0) / cd)); iz <= Math.min(this.nz - 1, Math.floor((c[2] + R - this.z0) / cd)); iz++)
        for (let ix = Math.max(0, Math.floor((c[0] - R - this.x0) / cw)); ix <= Math.min(this.nx - 1, Math.floor((c[0] + R - this.x0) / cw)); ix++) {
          const i = this.idx(ix, iy, iz);
          if (this.state[i] !== 1) continue;
          const h = this.home(ix, iy, iz);
          const bx = Math.max(Math.abs(h[0] - c[0]) - cw / 2, 0), by = Math.max(Math.abs(h[1] - c[1]) - ch / 2, 0), bz = Math.max(Math.abs(h[2] - c[2]) - cd / 2, 0);
          if (bx * bx + by * by + bz * bz <= R * R) cand.push([Math.hypot(h[0] - c[0], h[1] - c[1], h[2] - c[2]), i, h]);
        }
    cand.sort((a, b) => a[0] - b[0]);
    const n = Math.max(1, Math.min(pr.budget, cand.length));
    let k = 0;
    for (; k < n && k < cand.length; k++) {
      const [d, i, h] = cand[k];
      const ox = h[0] - c[0], oy = h[1] - c[1], oz = h[2] - c[2], ol = Math.hypot(ox, oy, oz) || 1;
      const push = sp * rand(0.15, 0.35) * (1 - d / (R + 1));
      this.toDebris(i,
        dir[0] * push + (ox / ol) * rand(3, 9) + rand(-2, 2),
        dir[1] * push * 0.5 + (oy / ol) * rand(2, 6) + rand(0, 5),
        dir[2] * push + (oz / ol) * rand(3, 9) + rand(-2, 2));
    }
    pr.budget -= Math.max(k, 1);
    this.events.push({ t: item.splat ? 'splat' : 'impact', x: p[0], y: p[1], z: p[2], n: k, s: item.blast });
    if (pr.budget <= 0 || item.splat) {
      if (item.splat) { pr.done = true; pr.hidden = true; return; }
      v[0] *= -0.15; v[1] *= 0.1; v[2] *= -0.15;
    } else {
      const f = Math.sqrt(pr.budget / pr.b0);
      v[0] *= f; v[1] *= f; v[2] *= f;
    }
  }

  stepProjectiles(dt) {
    const sub = 5, h = dt / sub;
    for (const pr of this.projectiles) {
      if (pr.done) continue;
      pr.t += dt;
      pr.rot += dt * 6;
      for (let s = 0; s < sub; s++) {
        const { p, v, item } = pr;
        v[1] -= G * h;
        const px = p[0], py = p[1], pz = p[2];
        p[0] += v[0] * h; p[1] += v[1] * h; p[2] += v[2] * h;
        const gh = 0;
        if (p[1] - item.r < gh) {
          p[1] = gh + item.r;
          if (!pr.landed && Math.abs(v[1]) > 4) this.events.push({ t: item.splat ? 'splat' : 'thud', x: p[0], y: p[1], z: p[2], n: 0, s: item.r });
          if (item.splat) { pr.done = true; pr.hidden = true; break; }
          v[1] = Math.abs(v[1]) * 0.25; v[0] *= 0.6; v[2] *= 0.6;
          pr.landed = (pr.landed || 0) + 1;
        }
        if (this.touching(p, item.r)) {
          if (pr.budget > 0) { this.impact(pr); if (pr.done) break; }
          else { p[0] = px; p[1] = py; p[2] = pz; v[0] *= -0.3; v[2] *= -0.3; v[1] = Math.min(v[1], 0); }
        }
      }
      const sp = Math.hypot(...pr.v);
      if ((pr.landed && sp < 1.5) || pr.t > 12 || Math.abs(pr.p[0]) > 400 || Math.abs(pr.p[2]) > 400) {
        pr.restT = (pr.restT || 0) + dt;
        if (pr.restT > 1.5 || pr.t > 12) pr.done = true;
      }
    }
    this.projectiles = this.projectiles.filter((p) => !p.done || p.keep);
  }

  makeCluster(cells, hint) {
    let cx = 0, cy = 0, cz = 0;
    for (const i of cells) { cx += this.pos[i * 3]; cy += this.pos[i * 3 + 1]; cz += this.pos[i * 3 + 2]; }
    cx /= cells.length; cy /= cells.length; cz /= cells.length;
    const off = new Float32Array(cells.length * 3);
    cells.forEach((i, k) => {
      off[k * 3] = this.pos[i * 3] - cx; off[k * 3 + 1] = this.pos[i * 3 + 1] - cy; off[k * 3 + 2] = this.pos[i * 3 + 2] - cz;
      this.leaveStatic(i); this.state[i] = 2;
    });
    let [hx, hz] = hint || [0, 0];
    let hl = Math.hypot(hx, hz);
    if (hl < 0.5) { const a = Math.random() * Math.PI * 2; hx = Math.cos(a); hz = Math.sin(a); hl = 0.2; }
    const size = Math.max(this.W, this.D) * 0.5;
    const mag = 0.05 + 0.45 * Math.min(1, hl / size) + rand(0, 0.05);
    const ux = hx / Math.hypot(hx, hz), uz = hz / Math.hypot(hx, hz);
    const cl = {
      cells: Int32Array.from(cells), off, com: [cx, cy, cz], q: [0, 0, 0, 1], v: [0, 0, 0],
      w: [uz * mag, 0, -ux * mag], cap: cells.length * 1.25 + 10, alive: cells.length,
    };
    this.clusters.push(cl);
    this.events.push({ t: 'crack', x: cx, y: cy, z: cz, n: cells.length, s: 0 });
    return cl;
  }

  structural() {
    this.structDirty = false;
    const { nx, ny, nz, state } = this;
    // 1) 층별 과부하 검사: 남은 지지 비율이 위 하중에 비해 너무 작으면 그 층이 무너짐
    const A = new Int32Array(ny);
    for (let i = 0; i < this.N; i++) if (state[i] === 1) A[this.coords(i)[1]]++;
    let above = 0;
    const L = new Int32Array(ny);
    for (let y = ny - 1; y >= 0; y--) { L[y] = above; above += A[y]; }
    let hint = null;
    for (let y = 0; y < ny - 1; y++) {
      if (!this.layerOrig[y] || L[y] === 0 || A[y] === 0) continue;
      const ratio = A[y] / this.layerOrig[y];
      const thr = 0.2 + 0.45 * (L[y] / this.total);
      if (ratio < thr) {
        // 지지 중심 vs 위쪽 무게중심 → 기울어질 방향
        let sx = 0, sz = 0, mx = 0, mz = 0, mc = 0;
        for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
          const i = this.idx(ix, y, iz);
          if (state[i] === 1) { sx += this.pos[i * 3]; sz += this.pos[i * 3 + 2]; }
        }
        sx /= A[y]; sz /= A[y];
        for (let yy = y + 1; yy < ny; yy++) for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
          const i = this.idx(ix, yy, iz);
          if (state[i] === 1) { mx += this.pos[i * 3]; mz += this.pos[i * 3 + 2]; mc++; }
        }
        if (mc) { mx /= mc; mz /= mc; }
        hint = [(mx - sx) * 3, (mz - sz) * 3];
        for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
          const i = this.idx(ix, y, iz);
          if (state[i] === 1) this.toDebris(i, rand(-4, 4) + hint[0] * 0.2, rand(-1, 2), rand(-4, 4) + hint[1] * 0.2);
        }
        this.events.push({ t: 'fail', x: sx, y: (y + 0.5) * this.ch, z: sz, n: A[y], s: 0 });
        break;
      }
    }
    // 2) 지면과 연결되지 않은 부분 → 낙하 덩어리
    const vis = new Uint8Array(this.N);
    const q = [];
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const i = this.idx(ix, 0, iz);
      if (state[i] === 1) { vis[i] = 1; q.push(i); }
    }
    const nb = (i, f) => {
      const [ix, iy, iz] = this.coords(i);
      if (ix > 0) f(i - 1); if (ix < nx - 1) f(i + 1);
      if (iz > 0) f(i - nx); if (iz < nz - 1) f(i + nx);
      if (iy > 0) f(i - nx * nz); if (iy < ny - 1) f(i + nx * nz);
    };
    while (q.length) { const i = q.pop(); nb(i, (j) => { if (!vis[j] && state[j] === 1) { vis[j] = 1; q.push(j); } }); }
    for (let i = 0; i < this.N; i++) {
      if (state[i] !== 1 || vis[i]) continue;
      const comp = [i]; vis[i] = 1;
      for (let k = 0; k < comp.length; k++) nb(comp[k], (j) => { if (!vis[j] && state[j] === 1) { vis[j] = 1; comp.push(j); } });
      if (comp.length < 6) for (const j of comp) this.toDebris(j, rand(-1, 1), 0, rand(-1, 1));
      else this.makeCluster(comp, hint);
    }
  }

  stepClusters(dt) {
    const tmp = this._t;
    for (const cl of this.clusters) {
      if (cl.alive <= 0) continue;
      cl.v[1] -= G * dt;
      cl.com[0] += cl.v[0] * dt; cl.com[1] += cl.v[1] * dt; cl.com[2] += cl.v[2] * dt;
      const wm = Math.hypot(...cl.w);
      if (wm < 1.1) { const f = 1 + 0.9 * dt; cl.w[0] *= f; cl.w[2] *= f; }
      qMulAxis(cl.q, cl.w[0], cl.w[1], cl.w[2], dt);
      let crushed = 0;
      for (let k = 0; k < cl.cells.length; k++) {
        const i = cl.cells[k];
        if (i < 0) continue;
        qRot(cl.q, cl.off[k * 3], cl.off[k * 3 + 1], cl.off[k * 3 + 2], tmp);
        const x = cl.com[0] + tmp[0], y = cl.com[1] + tmp[1], z = cl.com[2] + tmp[2];
        this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
        this.quat.set(cl.q, i * 4);
        this.mark(i);
        // 점 속도 = v + w × r
        const pvx = cl.v[0] + (cl.w[1] * tmp[2] - cl.w[2] * tmp[1]);
        const pvy = cl.v[1] + (cl.w[2] * tmp[0] - cl.w[0] * tmp[2]);
        const pvz = cl.v[2] + (cl.w[0] * tmp[1] - cl.w[1] * tmp[0]);
        if (y < this.pileAt(x, z) + this.ch * 0.45) {
          this.toDebris(i, pvx * 0.45 + rand(-3, 3), Math.abs(pvy) * rand(0.05, 0.25), pvz * 0.45 + rand(-3, 3));
          cl.cells[k] = -1; cl.alive--;
          continue;
        }
        const c = this.cellAt(x, y - this.ch * 0.3, z);
        if (c >= 0 && this.state[c] === 1) {
          if (cl.cap > 0) {
            this.toDebris(c, pvx * 0.4 + rand(-5, 5), rand(-1, 3), pvz * 0.4 + rand(-5, 5));
            cl.cap--; crushed++;
          } else {
            // 더 이상 부술 힘이 없으면 덩어리가 산산조각 나서 그 위에 쌓임
            cl.shatter = true;
          }
        }
      }
      if (crushed) {
        cl.v[1] *= Math.pow(0.995, crushed);
        if (Math.random() < 0.15) this.events.push({ t: 'crush', x: cl.com[0], y: cl.com[1] - 20, z: cl.com[2], n: crushed, s: 0 });
      }
      if (cl.shatter || cl.alive < 4) {
        for (let k = 0; k < cl.cells.length; k++) {
          const i = cl.cells[k]; if (i < 0) continue;
          this.toDebris(i, cl.v[0] * 0.3 + rand(-2, 2), cl.v[1] * 0.2, cl.v[2] * 0.3 + rand(-2, 2));
        }
        cl.alive = 0;
      }
    }
    this.clusters = this.clusters.filter((c) => c.alive > 0);
  }

  stepDebris(dt) {
    const { pos, vel, ang, quat, state } = this;
    if (this.wakeCols.size) {
      for (let i = 0; i < this.N; i++) {
        if (state[i] !== 4) continue;
        const c = this.cellAt(pos[i * 3], Math.min(pos[i * 3 + 1], this.H - 1), pos[i * 3 + 2]);
        if (c < 0) continue;
        const [ix, , iz] = this.coords(c);
        if (this.wakeCols.has(ix + iz * this.nx) && pos[i * 3 + 1] > this.pileAt(pos[i * 3], pos[i * 3 + 2]) + this.ch) {
          state[i] = 3; this.awake[i] = 0;
        }
      }
      this.wakeCols.clear();
    }
    for (let i = 0; i < this.N; i++) {
      if (state[i] !== 3) continue;
      const o = i * 3;
      this.awake[i] += dt;
      const px = pos[o], py = pos[o + 1], pz = pos[o + 2];
      vel[o + 1] -= G * dt;
      let x = px + vel[o] * dt, y = py + vel[o + 1] * dt, z = pz + vel[o + 2] * dt;
      const half = 0.5 * this.ch * this.scale[i] * 0.85;
      const gh = this.pileAt(x, z);
      let rest = false;
      if (y - half < gh) {
        if (vel[o + 1] < -7 && Math.random() < 0.35) this.events.push({ t: 'land', x, y: gh, z, n: 1, s: -vel[o + 1] });
        y = gh + half;
        vel[o + 1] = -vel[o + 1] * 0.18; vel[o] *= 0.55; vel[o + 2] *= 0.55;
        ang[o] *= 0.5; ang[o + 1] *= 0.5; ang[o + 2] *= 0.5;
        rest = true;
      }
      const c = this.cellAt(x, y, z);
      if (c >= 0 && state[c] === 1) {
        const top = (Math.floor(y / this.ch) + 1) * this.ch;
        if (py - half >= top - this.ch * 0.6) {
          y = top + half; vel[o + 1] = Math.abs(vel[o + 1]) * 0.15; vel[o] *= 0.5; vel[o + 2] *= 0.5; rest = true;
        } else {
          x = px; z = pz; vel[o] *= -0.3; vel[o + 2] *= -0.3;
        }
      }
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      const q = [quat[i * 4], quat[i * 4 + 1], quat[i * 4 + 2], quat[i * 4 + 3]];
      qMulAxis(q, ang[o], ang[o + 1], ang[o + 2], dt);
      quat.set(q, i * 4);
      this.mark(i);
      const sp2 = vel[o] ** 2 + vel[o + 1] ** 2 + vel[o + 2] ** 2;
      if ((rest && sp2 < 2.5) || this.awake[i] > 14 || y < -30) {
        state[i] = 4;
        vel[o] = vel[o + 1] = vel[o + 2] = 0;
        if (y - half <= this.pileAt(x, z) + 0.5) this.pileAdd(x, z, y + half * 0.75);
      }
    }
  }

  step(dt) {
    dt = Math.min(dt, 1 / 30);
    this.stepProjectiles(dt);
    this.stepClusters(dt);
    this.stepDebris(dt);
    if (this.structDirty) this.structural();
  }

  busy() {
    if (this.projectiles.length || this.clusters.length) return true;
    let a = 0;
    for (let i = 0; i < this.N; i++) if (this.state[i] === 3) a++;
    return a > 20;
  }
}
