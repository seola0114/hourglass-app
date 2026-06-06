import { describe, it, expect } from 'vitest';
import {
  HourglassSim,
  bulgeRadius,
  gravityFromAngle,
  NECK_R,
  MAX_R,
  type Rng,
} from './simulation';

// 결정론적 테스트용 시드 RNG (mulberry32).
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('bulgeRadius', () => {
  it('neck(d=0)에서 NECK_R', () => {
    expect(bulgeRadius(0)).toBeCloseTo(NECK_R, 10);
  });

  it('항상 [NECK_R, MAX_R] 범위 안', () => {
    for (let i = 0; i <= 100; i++) {
      const r = bulgeRadius(i / 100);
      expect(r).toBeGreaterThanOrEqual(NECK_R - 1e-9);
      expect(r).toBeLessThanOrEqual(MAX_R + 1e-9);
    }
  });

  it('neck이 전체 최소 반경', () => {
    const neck = bulgeRadius(0);
    for (let i = 1; i <= 100; i++) {
      expect(bulgeRadius(i / 100)).toBeGreaterThanOrEqual(neck - 1e-9);
    }
  });
});

describe('gravityFromAngle', () => {
  it('90° 단위 각도를 올바른 방향으로 환산', () => {
    expect(gravityFromAngle(0)).toBe('down');
    expect(gravityFromAngle(Math.PI / 2)).toBe('left');
    expect(gravityFromAngle(Math.PI)).toBe('up');
    expect(gravityFromAngle((3 * Math.PI) / 2)).toBe('right');
  });

  it('2π 주기로 wrap', () => {
    expect(gravityFromAngle(2 * Math.PI)).toBe('down');
    expect(gravityFromAngle(-Math.PI / 2)).toBe('right');
    expect(gravityFromAngle(4 * Math.PI + Math.PI)).toBe('up');
  });
});

describe('HourglassSim 초기화', () => {
  it('모래는 경계(bnd) 안에만 존재', () => {
    const sim = new HourglassSim({ rng: seeded(1) });
    for (let i = 0; i < sim.sand.length; i++) {
      if (sim.sand[i]) expect(sim.bnd[i]).toBe(1);
    }
  });

  it('경계가 중심열에 대해 좌우 대칭', () => {
    const sim = new HourglassSim();
    const { gW, gH, bnd } = sim;
    for (let r = 0; r < gH; r++) {
      for (let c = 0; c < gW; c++) {
        const mc = gW - 1 - c;
        expect(bnd[r * gW + c]).toBe(bnd[r * gW + mc]);
      }
    }
  });

  it('가득 찬 상태에서 maxSandCount === totalSandCount', () => {
    const sim = new HourglassSim({ sandFill: 1.0 });
    expect(sim.totalSandCount).toBeGreaterThan(0);
    expect(sim.maxSandCount).toBe(sim.totalSandCount);
  });

  it('neckFlowPerSecond = 모래수 / duration', () => {
    const sim = new HourglassSim({ duration: 30 });
    expect(sim.neckFlowPerSecond).toBeCloseTo(sim.totalSandCount / 30, 6);
  });
});

describe('fillBottom 채움 비율', () => {
  it('비율이 높을수록 모래가 더 많다 (단조 증가)', () => {
    const counts = [0, 0.25, 0.5, 0.75, 1.0].map((f) => {
      const sim = new HourglassSim({ sandFill: f, rng: seeded(2) });
      return sim.totalSandCount;
    });
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
    expect(counts[0]).toBe(0);
    expect(counts[counts.length - 1]).toBeGreaterThan(0);
  });

  it('setSandToTime은 목 굵기를 유지한 채 총 시간을 목표값에 맞춘다', () => {
    const sim = new HourglassSim({ sandFill: 1.0, duration: 60, rng: seeded(9) });
    const neck0 = sim.neckHW;
    sim.setSandToTime(30); // 절반 시간 → 모래가 줄어든다
    expect(sim.neckHW).toBe(neck0); // 목은 그대로
    expect(sim.duration).toBeLessThan(60);
    expect(Math.abs(sim.duration - 30)).toBeLessThan(8); // 슬라이더 스텝 내 근사
  });

  it('setSandFill은 모래수와 총 시간을 갱신 (흐름률은 목 굵기 고정)', () => {
    const sim = new HourglassSim({ sandFill: 1.0, duration: 60 });
    const full = sim.totalSandCount;
    const rate = sim.neckFlowPerSecond;
    sim.setSandFill(0.5);
    expect(sim.totalSandCount).toBeLessThan(full);
    // 목이 그대로면 흐름률은 동일하고, 모래가 줄면 총 시간이 짧아진다.
    expect(sim.neckFlowPerSecond).toBeCloseTo(rate, 6);
    expect(sim.duration).toBeCloseTo(sim.totalSandCount / rate, 6);
    expect(sim.duration).toBeLessThan(60);
  });
});

describe('flipGrid', () => {
  it('점대칭 뒤집기는 involution (두 번 적용 시 원상복구)', () => {
    const sim = new HourglassSim({ rng: seeded(3) });
    const before = Uint8Array.from(sim.sand);
    sim.flipGrid();
    expect(sim.sand).not.toEqual(before);
    sim.flipGrid();
    expect(sim.sand).toEqual(before);
  });

  it('뒤집은 뒤 모래 수가 보존된다', () => {
    const sim = new HourglassSim({ rng: seeded(4) });
    const n0 = sim.countSand();
    sim.flipGrid();
    expect(sim.countSand()).toBe(n0);
  });

  it('바닥을 채운 뒤 뒤집으면 상단 bulb로 이동 → isDone false', () => {
    const sim = new HourglassSim({ rng: seeded(5) });
    expect(sim.isDone()).toBe(true); // 바닥만 차 있으면 상단은 비어 done
    sim.flipGrid();
    expect(sim.isDone()).toBe(false); // 상단으로 옮겨짐
  });
});

describe('setNeck (목 굵기)', () => {
  it('목을 좁히면 총 시간이 길어지고 넓히면 짧아진다', () => {
    const sim = new HourglassSim({ neckHW: 2, duration: 60 });
    expect(sim.duration).toBeCloseTo(60, 0);
    sim.setNeck(1);
    expect(sim.neckHW).toBe(1);
    expect(sim.duration).toBeGreaterThan(60);
    sim.setNeck(6);
    expect(sim.neckHW).toBe(6);
    expect(sim.duration).toBeLessThan(60);
  });

  it('setDuration은 모래 양을 유지한 채 목 굵기를 역산한다', () => {
    const sim = new HourglassSim({ neckHW: 2, duration: 60 });
    sim.setDuration(20); // 짧게 → 목이 굵어짐
    expect(sim.neckHW).toBeGreaterThan(2);
    expect(sim.duration).toBeLessThan(60);
    sim.setDuration(120); // 길게 → 목이 좁아짐
    expect(sim.neckHW).toBeLessThan(2);
    expect(sim.duration).toBeGreaterThan(60);
  });

  it('목을 넓히면 유리 잘록함(neckR)이 커진다', () => {
    const sim = new HourglassSim({ neckHW: 2 });
    const r0 = sim.neckR;
    sim.setNeck(4);
    expect(sim.neckR).toBeGreaterThan(r0);
    expect(bulgeRadius(0, sim.neckR)).toBeCloseTo(sim.neckR, 10);
  });

  it('목을 바꿔도 경계는 좌우 대칭을 유지한다', () => {
    const sim = new HourglassSim({ neckHW: 2 });
    sim.setNeck(5);
    const { gW, gH, bnd } = sim;
    for (let r = 0; r < gH; r++) {
      for (let c = 0; c < gW; c++) {
        expect(bnd[r * gW + c]).toBe(bnd[r * gW + (gW - 1 - c)]);
      }
    }
  });
});

describe('시뮬레이션 stepping', () => {
  it('모래 수는 항상 보존된다 (질량 보존)', () => {
    const sim = new HourglassSim({ rng: seeded(6) });
    sim.flipGrid();
    const n0 = sim.countSand();
    for (let i = 0; i < 300; i++) {
      sim.addFlowBudget(0.05);
      sim.stepGravity('down');
      expect(sim.countSand()).toBe(n0);
    }
  });

  it('neckFlowBudget=0이면 gate가 막혀 상단 모래가 통과하지 못한다', () => {
    const sim = new HourglassSim({ rng: seeded(7) });
    sim.flipGrid();
    sim.resetFlowBudget();
    for (let i = 0; i < 200; i++) {
      sim.resetFlowBudget(); // 예산을 계속 0으로 유지
      sim.stepGravity('down');
    }
    // 상단(neck 위) 모래가 남아 있어야 함
    expect(sim.isDone()).toBe(false);
  });

  it('충분한 시간/예산이면 모래가 모두 아래로 떨어져 완료된다', () => {
    const sim = new HourglassSim({ rng: seeded(8) });
    sim.flipGrid();
    let done = false;
    for (let i = 0; i < 20000 && !done; i++) {
      sim.addFlowBudget(0.1);
      sim.stepGravity('down');
      done = sim.isDone();
    }
    expect(done).toBe(true);
  });
});
