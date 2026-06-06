// 모래시계 모래 시뮬레이션 코어 — Three.js·DOM에 의존하지 않는 순수 로직.
// 셀 격자 위에서 동작하는 셀룰러 오토마톤. 렌더러는 이 클래스가 노출하는
// 격자 상태(sand/clr/bnd)와 프로파일 함수를 읽어 3D 메시를 그린다.

// ── Profile geometry (유리 외형과 격자 경계가 공유) ──
export const HG_H = 4;
export const MAX_R = 0.82;
export const NECK_R = 0.12;

// d in [0,1]: 0 = neck(중앙), 1 = 위/아래 끝. neckR로 잘록함을 조절.
export function bulgeRadius(d: number, neckR: number = NECK_R): number {
  const smooth = d * d * (3 - 2 * d);
  const shoulder = Math.sin(smooth * Math.PI * 0.5);
  const taper = 1 - Math.pow(d, 7) * 0.38;
  return neckR + (MAX_R - neckR) * Math.pow(shoulder, 0.82) * taper;
}

export type Rng = () => number;

export interface SimOptions {
  gW?: number;
  gH?: number;
  neckHW?: number;
  /** 기준 총 시간(초) — 기본 목 굵기·가득 찬 모래에서의 낙하 시간. 실제 duration은 목·모래에 따라 파생. */
  duration?: number;
  /** 바닥 bulb 채움 비율 0~1 (1=가득). */
  sandFill?: number;
  /** 표면 모래가 한 step에 미끄러질 수 있는 최대 셀 수(안식각). */
  slideMax?: number;
  /** 모래 색상 변형 개수. */
  colorCount?: number;
  /** 결정론적 테스트를 위해 주입 가능한 난수원. 기본 Math.random. */
  rng?: Rng;
}

/** 시뮬레이션이 처리하는 중력 방향(grid 기준). */
export type GravityDir = 'down' | 'up' | 'left' | 'right';

const TAU = Math.PI * 2;

/** 회전각(라디안)을 가장 가까운 90° 중력 방향으로 환산. */
export function gravityFromAngle(angle: number): GravityDir {
  const theta = ((angle % TAU) + TAU) % TAU;
  if (theta < Math.PI / 4 || theta >= (7 * Math.PI) / 4) return 'down';
  if (theta < (3 * Math.PI) / 4) return 'left';
  if (theta < (5 * Math.PI) / 4) return 'up';
  return 'right';
}

export class HourglassSim {
  readonly gW: number;
  readonly gH: number;
  /** neck 통로 반폭(셀). 클수록 목이 굵고 통과가 빠르다. setNeck로 조절. */
  neckHW: number;
  /** neck 3D 반경(유리 잘록함). neckHW에 비례해 setNeck에서 갱신. */
  neckR: number;
  /** 흐름 속도 기준이 되는 최초 neckHW. */
  readonly baseNeckHW: number;
  readonly cCol: number;
  readonly cRow: number;
  readonly maxHW: number;

  readonly sand: Uint8Array;
  readonly clr: Uint8Array;
  readonly bnd: Uint8Array;
  readonly mv: Uint8Array;

  duration: number;
  sandFill: number;
  slideMax: number;
  colorCount: number;

  totalSandCount = 0;
  /** 지금까지 본 최대 모래 수 — 렌더 버퍼 용량 산정용. neck을 넓히면 갱신될 수 있음. */
  maxSandCount: number;
  neckFlowBudget = 0;
  neckFlowPerSecond = 0;
  /** 흐름 속도 보정 상수 — neckFlowPerSecond = flowK * neckHW. */
  readonly flowK: number;

  private readonly colArr: number[];
  private readonly rowArr: number[];
  private readonly rng: Rng;

  constructor(opts: SimOptions = {}) {
    this.gW = opts.gW ?? 65;
    this.gH = opts.gH ?? 130;
    this.neckHW = opts.neckHW ?? 2;
    this.baseNeckHW = this.neckHW;
    this.neckR = NECK_R;
    this.duration = opts.duration ?? 60;
    this.sandFill = opts.sandFill ?? 1.0;
    this.slideMax = opts.slideMax ?? 3;
    this.colorCount = opts.colorCount ?? 8;
    this.rng = opts.rng ?? Math.random;

    this.cCol = this.gW >> 1;
    this.cRow = this.gH >> 1;
    this.maxHW = this.cCol;

    const n = this.gW * this.gH;
    this.sand = new Uint8Array(n);
    this.clr = new Uint8Array(n);
    this.bnd = new Uint8Array(n);
    this.mv = new Uint8Array(n);
    this.colArr = Array.from({ length: this.gW }, (_, i) => i);
    this.rowArr = Array.from({ length: this.gH }, (_, i) => i);

    this.buildBoundary();
    this.fillBottom();
    this.totalSandCount = this.countSand();
    this.maxSandCount = this.totalSandCount;
    // flowK 보정: 기본 목 굵기·가득 찬 모래에서 this.duration(기준 시간)이 나오도록.
    this.flowK = this.totalSandCount / (this.baseNeckHW * this.duration);
    this.recomputeFlow();
  }

  // 물리 제약 양방향 모델: 흐름 속도는 목 굵기가 결정하는 물리량(flowK * neckHW),
  // 총 시간(duration)은 모래 양 ÷ 흐름 속도로 파생된다.
  private recomputeFlow(): void {
    this.neckFlowPerSecond = this.flowK * this.neckHW;
    this.duration = this.totalSandCount / this.neckFlowPerSecond;
  }

  /** 격자 row의 중심 기준 반폭(half-width, 셀 단위). */
  hw2(row: number): number {
    const d = Math.abs(row / (this.gH - 1) - 0.5) * 2;
    const r = bulgeRadius(d, this.neckR);
    const norm = (r - this.neckR) / (MAX_R - this.neckR);
    return Math.max(this.neckHW, Math.floor(this.neckHW + (this.maxHW - this.neckHW) * norm));
  }

  /** 격자 row의 3D 반경. */
  radius3D(row: number): number {
    const d = Math.abs(row / (this.gH - 1) - 0.5) * 2;
    return bulgeRadius(d, this.neckR);
  }

  private buildBoundary(): void {
    for (let r = 0; r < this.gH; r++) {
      const w = this.hw2(r);
      const d = Math.abs(r / (this.gH - 1) - 0.5) * 2;
      // 어깨 외곽(좁아지는 rim) 제외 → 모래가 갇히는 자리 자체를 제거
      const inBulb = d <= 0.82;
      for (let c = 0; c < this.gW; c++) {
        this.bnd[r * this.gW + c] = inBulb && Math.abs(c - this.cCol) <= w ? 1 : 0;
      }
    }
  }

  countSand(): number {
    let s = 0;
    for (let i = 0; i < this.sand.length; i++) s += this.sand[i];
    return s;
  }

  /** 채움 비율 ratio일 때 모래가 시작되는 row. */
  private fillStartRow(ratio: number): number {
    const startBase = this.cRow + 2;
    const rows = this.gH - startBase;
    return startBase + Math.floor((1 - ratio) * rows);
  }

  /** 바닥 bulb를 sandFill 비율만큼 모래로 채운다. */
  fillBottom(): void {
    this.sand.fill(0);
    const startRow = this.fillStartRow(this.sandFill);
    for (let r = startRow; r < this.gH; r++) {
      for (let c = 0; c < this.gW; c++) {
        const i = r * this.gW + c;
        if (this.bnd[i]) {
          this.sand[i] = 1;
          this.clr[i] = (this.rng() * this.colorCount) | 0;
        }
      }
    }
  }

  /** 채움 비율 ratio일 때의 모래 셀 수(실제 채우지 않고 계산). */
  sandCountForFill(ratio: number): number {
    const startRow = this.fillStartRow(ratio);
    let s = 0;
    for (let r = startRow; r < this.gH; r++)
      for (let c = 0; c < this.gW; c++) if (this.bnd[r * this.gW + c]) s++;
    return s;
  }

  /** 총 시간(역방향): 모래 양을 유지한 채 목표 시간이 나오는 목 굵기를 역산해 적용. */
  setDuration(seconds: number): void {
    const targetNeck = this.totalSandCount / (this.flowK * seconds);
    this.setNeck(Math.max(1, Math.min(6, Math.round(targetNeck))));
  }

  setSandFill(ratio: number): void {
    this.sandFill = ratio;
    this.fillBottom();
    this.totalSandCount = this.countSand();
    this.recomputeFlow();
  }

  /** 총 시간(역방향): 목 굵기를 유지한 채 목표 시간이 나오는 모래 양을 슬라이더 스텝에서 탐색해 적용. */
  setSandToTime(seconds: number): void {
    const targetCount = seconds * this.flowK * this.neckHW;
    let bestFill = 0.1;
    let bestErr = Infinity;
    for (let pct = 10; pct <= 100; pct += 5) {
      const fill = pct / 100;
      const err = Math.abs(this.sandCountForFill(fill) - targetCount);
      if (err < bestErr) {
        bestErr = err;
        bestFill = fill;
      }
    }
    this.setSandFill(bestFill);
  }

  /** neck 굵기(통로 반폭, 셀)를 조절. 유리 잘록함·통로·흐름 속도를 함께 갱신. */
  setNeck(halfWidth: number): void {
    this.neckHW = Math.max(1, Math.min(this.maxHW, Math.round(halfWidth)));
    this.neckR = NECK_R * (this.neckHW / this.baseNeckHW);
    this.buildBoundary();
    this.fillBottom();
    this.totalSandCount = this.countSand();
    if (this.totalSandCount > this.maxSandCount) this.maxSandCount = this.totalSandCount;
    this.recomputeFlow();
  }

  /** dt(초)만큼 neck 통과 예산 누적. 상한은 목이 굵을수록 커짐. */
  addFlowBudget(dt: number, cap = Math.max(3, this.neckHW * 2)): void {
    this.neckFlowBudget = Math.min(this.neckFlowBudget + this.neckFlowPerSecond * dt, cap);
  }

  resetFlowBudget(): void {
    this.neckFlowBudget = 0;
  }

  private shuffle(a: number[]): void {
    for (let i = a.length - 1; i > 0; i--) {
      const j = (this.rng() * (i + 1)) | 0;
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
  }

  /** 한 시뮬레이션 step. angle(라디안)으로 중력 방향을 결정. */
  step(angle: number): void {
    this.stepGravity(gravityFromAngle(angle));
  }

  stepGravity(g: GravityDir): void {
    this.mv.fill(0);
    if (g === 'down') this.simStepVertical(1);
    else if (g === 'up') this.simStepVertical(-1);
    else if (g === 'left') this.simStepHorizontal(-1);
    else this.simStepHorizontal(1);
  }

  // dir: 중력 grid r 방향. +1 = 정상(+r 낙하), -1 = 180° 뒤집힘(-r 낙하).
  private simStepVertical(dir: number): void {
    const { gW, gH, sand, clr, bnd, mv, cRow } = this;
    const rStart = dir === 1 ? gH - 2 : 1;
    const rEnd = dir === 1 ? -1 : gH;
    const rStep = dir === 1 ? -1 : 1;
    for (let r = rStart; r !== rEnd; r += rStep) {
      this.shuffle(this.colArr);
      for (let ci = 0; ci < gW; ci++) {
        const c = this.colArr[ci];
        const i = r * gW + c;
        if (!sand[i] || mv[i]) continue;
        const isGate = r === cRow;
        if (isGate && this.neckFlowBudget < 1) continue;
        const b = (r + dir) * gW + c;
        if (bnd[b] && !sand[b]) {
          sand[b] = 1;
          clr[b] = clr[i];
          sand[i] = 0;
          mv[b] = 1;
          if (isGate) this.neckFlowBudget -= 1;
          continue;
        }
        const oppR = r - dir;
        const oppValid = oppR >= 0 && oppR < gH;
        const isPileTop = !oppValid || !sand[oppR * gW + c];
        const onWall = !bnd[b];
        const slideMax = isPileTop || onWall ? this.slideMax : 1;
        const d1 = this.rng() < 0.5 ? 1 : -1;
        for (const dirSign of [d1, -d1]) {
          let landDi = -1;
          for (let step = 1; step <= slideMax; step++) {
            const nc = c + dirSign * step;
            if (nc < 0 || nc >= gW) break;
            if (sand[r * gW + nc]) break;
            const di = (r + dir) * gW + nc;
            if (!bnd[di]) continue;
            if (!sand[di]) {
              landDi = di;
              break;
            }
          }
          if (landDi >= 0) {
            sand[landDi] = 1;
            clr[landDi] = clr[i];
            sand[i] = 0;
            mv[landDi] = 1;
            if (isGate) this.neckFlowBudget -= 1;
            break;
          }
        }
      }
    }
  }

  // dir: 중력의 grid c 방향. -1 = 좌측(c 감소), +1 = 우측. neck throttle 없음.
  private simStepHorizontal(dir: number): void {
    const { gW, gH, sand, clr, bnd, mv } = this;
    const cStart = dir === -1 ? 1 : gW - 2;
    const cEnd = dir === -1 ? gW : -1;
    const cStep = dir === -1 ? 1 : -1;
    for (let c = cStart; c !== cEnd; c += cStep) {
      this.shuffle(this.rowArr);
      for (let ri = 0; ri < gH; ri++) {
        const r = this.rowArr[ri];
        const i = r * gW + c;
        if (!sand[i] || mv[i]) continue;
        const targetC = c + dir;
        const tgt = r * gW + targetC;
        if (bnd[tgt] && !sand[tgt]) {
          sand[tgt] = 1;
          clr[tgt] = clr[i];
          sand[i] = 0;
          mv[tgt] = 1;
          continue;
        }
        const oppC = c - dir;
        const oppValid = oppC >= 0 && oppC < gW;
        const isPileTop = !oppValid || !sand[r * gW + oppC];
        const onWall = !bnd[tgt];
        const slideMax = isPileTop || onWall ? this.slideMax : 1;
        const d1 = this.rng() < 0.5 ? 1 : -1;
        for (const dirSign of [d1, -d1]) {
          let landDi = -1;
          for (let step = 1; step <= slideMax; step++) {
            const nr = r + dirSign * step;
            if (nr < 0 || nr >= gH) break;
            if (sand[nr * gW + c]) break;
            const di = nr * gW + targetC;
            if (!bnd[di]) continue;
            if (!sand[di]) {
              landDi = di;
              break;
            }
          }
          if (landDi >= 0) {
            sand[landDi] = 1;
            clr[landDi] = clr[i];
            sand[i] = 0;
            mv[landDi] = 1;
            break;
          }
        }
      }
    }
  }

  /** 격자를 점대칭(상하·좌우)으로 뒤집는다. */
  flipGrid(): void {
    const { gW, gH, sand, clr, bnd } = this;
    const n = gW * gH;
    const ts = new Uint8Array(n);
    const tc = new Uint8Array(n);
    for (let r = 0; r < gH; r++) {
      const mr = gH - 1 - r;
      for (let c = 0; c < gW; c++) {
        const mc = gW - 1 - c;
        const si = r * gW + c;
        const di = mr * gW + mc;
        if (sand[si] && bnd[di]) {
          ts[di] = 1;
          tc[di] = clr[si];
        }
      }
    }
    sand.set(ts);
    clr.set(tc);
  }

  /** 상단 bulb(neck 위쪽)에 모래가 모두 빠졌는지. */
  isDone(): boolean {
    const { gW, cRow, sand } = this;
    for (let r = 0; r <= cRow; r++)
      for (let c = 0; c < gW; c++) if (sand[r * gW + c]) return false;
    return true;
  }
}
