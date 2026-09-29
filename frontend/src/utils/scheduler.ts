import type { Instrument, ObsNight, ObsSession, ObsTarget, Telescope } from '../types';
import { altitudeAt, minutesToTime, nightAxisMinutes } from './astro';

/** 排程采样粒度（分钟）：窗口采样与落格都取 10 分钟，避免出现 20:03 这类碎时刻 */
export const PLAN_STEP_MINUTES = 10;
/** 计划帧数上限（行星视频等高帧率场景封顶） */
export const MAX_PLANNED_FRAMES = 9999;
/** 月相偏亮阈值（%）：达到该值且目标偏暗时，宽带滤镜自动改窄带 */
export const BRIGHT_MOON_PCT = 60;
/** 暗目标视星等阈值 */
export const DARK_TARGET_MAG = 8;
/** 月相偏亮时暗目标改用的窄带滤镜 */
export const NARROWBAND_FILTER = 'Ha';
const BROADBAND_FILTERS = new Set(['无滤镜', 'L', 'R', 'G', 'B']);

/** 目标在当夜的最长可见窗口 */
export interface TargetWindow {
  targetId: string;
  /** 窗口起点（相对当日 18:00 的分钟刻度） */
  startAxis: number;
  /** 窗口终点（分钟刻度） */
  endAxis: number;
  /** 窗口内最大地平高度角（度） */
  maxAltitude: number;
}

/** 算法排出的单个排程段（尚未落库，id 由 store 分配） */
export interface PlannedSlot {
  targetId: string;
  telescopeId: string;
  instrumentId: string;
  startAxis: number;
  endAxis: number;
  startTime: string;
  endTime: string;
  filterSlot: string;
  plannedFrames: number;
  /** 因月相偏亮由宽带改为窄带 Ha */
  narrowbandSwitched: boolean;
}

/** 排不进去的目标及原因 */
export interface UnscheduledTarget {
  targetId: string;
  name: string;
  priority: ObsTarget['priority'];
  reason: string;
  /** 可见窗口文案（若曾算出窗口） */
  windowText?: string;
  /** 窗口内最大高度角（若曾算出窗口） */
  maxAltitude?: number;
}

export interface AutoPlanResult {
  nightId: string;
  planned: PlannedSlot[];
  unscheduled: UnscheduledTarget[];
  /** 输入签名：输入（目标/设备/固定段/待执行段）不变时重复点击不重排 */
  signature: string;
}

export interface AutoPlanInput {
  night: ObsNight;
  targets: ObsTarget[];
  telescopes: Telescope[];
  instruments: Instrument[];
  /** 该夜全部现存排程段：已完成/进行中作为固定占用，待执行段会被整段重排 */
  nightSessions: ObsSession[];
}

interface FreeInterval {
  start: number;
  end: number;
}

/** 夜轴上的可用望远镜：状态为可用、配 CMOS 相机终端且时长向上取整到 10 分钟 */
function roundUpStep(value: number): number {
  return Math.ceil(value / PLAN_STEP_MINUTES) * PLAN_STEP_MINUTES;
}

/** 计划帧数 = 建议累计时长 ÷ 单帧曝光（封顶 9999；曝光秒数为 0 时不拆帧） */
export function plannedFramesFor(target: Pick<ObsTarget, 'totalMinutes' | 'exposureSec'>): number {
  if (!(target.exposureSec > 0)) return 0;
  return Math.min(MAX_PLANNED_FRAMES, Math.max(1, Math.round((target.totalMinutes * 60) / target.exposureSec)));
}

/** 月相偏亮时暗目标是否应从宽带改窄带 */
export function shouldUseNarrowband(target: Pick<ObsTarget, 'magnitude' | 'filter' | 'type'>, moonPhasePct: number): boolean {
  if (moonPhasePct < BRIGHT_MOON_PCT) return false;
  if (target.type === '行星' || target.type === '月面') return false;
  return target.magnitude >= DARK_TARGET_MAG && BROADBAND_FILTERS.has(target.filter);
}

/** 夜轴区间 [from, to] 内最长连续可见窗口（按 PLAN_STEP_MINUTES 采样最低高度阈值） */
export function sampleWindow(target: ObsTarget, night: ObsNight, from: number, to: number): TargetWindow | null {
  const base = new Date(`${night.date}T18:00:00`);
  let best: { start: number; end: number; maxAlt: number } | null = null;
  let runStart: number | null = null;
  let lastVisible: number | null = null;
  let runMax = -Infinity;

  for (let axis = from; axis <= to; axis += PLAN_STEP_MINUTES) {
    const date = new Date(base.getTime() + axis * 60_000);
    const altitude = altitudeAt(target, date, night.siteLat, night.siteLng);
    if (altitude >= target.minAltitude) {
      if (runStart === null) runStart = axis;
      lastVisible = axis;
      runMax = Math.max(runMax, altitude);
    } else if (runStart !== null && lastVisible !== null) {
      const end = lastVisible + PLAN_STEP_MINUTES;
      if (!best || end - runStart > best.end - best.start) best = { start: runStart, end, maxAlt: runMax };
      runStart = null;
      lastVisible = null;
      runMax = -Infinity;
    }
  }
  if (runStart !== null && lastVisible !== null) {
    const end = Math.min(to, lastVisible + PLAN_STEP_MINUTES);
    if (!best || end - runStart > best.end - best.start) best = { start: runStart, end, maxAlt: runMax };
  }
  if (!best) return null;
  return { targetId: target.id, startAxis: best.start, endAxis: best.end, maxAltitude: Number(best.maxAlt.toFixed(1)) };
}

/**
 * 本夜自动编排：
 * 1. 仅使用「可用」望远镜（维护中/外出不参与），且需配有 CMOS 相机终端；
 * 2. 已完成/进行中排程段视为固定占用，待执行段全部清掉重排；
 * 3. 目标按 P1→P2→P3、同优先级按可见窗口结束时刻升序（窗口快结束的先排）；
 * 4. 每台镜子独立做最早可行落格，保证同镜时段不重叠。
 */
export function autoPlanNight(input: AutoPlanInput): AutoPlanResult {
  const { night, targets, telescopes, instruments, nightSessions } = input;

  const horizonStart = Math.max(0, nightAxisMinutes(night.sunset));
  const horizonEnd = Math.max(horizonStart, Math.min(12 * 60, nightAxisMinutes(night.sunrise)));

  const usable = telescopes.filter((telescope) => telescope.status === '可用');
  const instrumentByTel = new Map<string, Instrument>();
  usable.forEach((telescope) => {
    const instrument = instruments.find(
      (item) => item.telescopeCode === telescope.code && item.terminalType === 'CMOS 相机',
    );
    if (instrument) instrumentByTel.set(telescope.id, instrument);
  });
  const availableTelescopes = usable
    .filter((telescope) => instrumentByTel.has(telescope.id))
    .sort((a, b) => a.code.localeCompare(b.code));

  // 固定占用：已完成 / 进行中（含因云取消等其它状态，一律保留不动且不占可排资源）
  const fixed = nightSessions.filter((session) => session.status === '已完成' || session.status === '进行中');
  const fixedTargetIds = new Set(fixed.map((session) => session.targetId));
  const busyByTel = new Map<string, Array<{ start: number; end: number }>>();
  availableTelescopes.forEach((telescope) => busyByTel.set(telescope.id, []));
  fixed.forEach((session) => {
    if (!busyByTel.has(session.telescopeId)) return;
    const start = nightAxisMinutes(session.startTime);
    let end = nightAxisMinutes(session.endTime);
    if (end <= start) end += 1440;
    busyByTel.get(session.telescopeId)!.push({ start, end });
  });

  /** 扣掉固定占用后的空闲区间（落在夜轴 [horizonStart, horizonEnd] 内） */
  const freeIntervals = (telescopeId: string): FreeInterval[] => {
    let intervals: FreeInterval[] = [{ start: horizonStart, end: horizonEnd }];
    const busy = (busyByTel.get(telescopeId) ?? [])
      .map((item) => ({ start: Math.max(horizonStart, item.start), end: Math.min(horizonEnd, item.end) }))
      .filter((item) => item.end > item.start)
      .sort((a, b) => a.start - b.start);
    busy.forEach((item) => {
      intervals = intervals.flatMap((interval) => {
        if (item.end <= interval.start || item.start >= interval.end) return [interval];
        const pieces: FreeInterval[] = [];
        if (item.start > interval.start) pieces.push({ start: interval.start, end: item.start });
        if (item.end < interval.end) pieces.push({ start: item.end, end: interval.end });
        return pieces;
      });
    });
    return intervals;
  };

  const targetById = new Map(targets.map((target) => [target.id, target]));

  // 固定段已占用的目标不再排入（避免同目标重复）
  const candidates = targets.filter((target) => !fixedTargetIds.has(target.id));

  const windows = new Map<string, TargetWindow | null>();
  candidates.forEach((target) => windows.set(target.id, sampleWindow(target, night, horizonStart, horizonEnd)));

  const priorityRank: Record<ObsTarget['priority'], number> = { P1: 0, P2: 1, P3: 2 };
  const ordered = [...candidates].sort((a, b) => {
    const rank = priorityRank[a.priority] - priorityRank[b.priority];
    if (rank !== 0) return rank;
    const wa = windows.get(a.id)?.endAxis ?? Infinity;
    const wb = windows.get(b.id)?.endAxis ?? Infinity;
    if (wb !== wa) return wa - wb;
    return a.name.localeCompare(b.name, 'zh');
  });

  const planned: PlannedSlot[] = [];
  const unscheduled: UnscheduledTarget[] = [];

  for (const target of ordered) {
    const window = windows.get(target.id) ?? null;
    const name = target.name;

    if (availableTelescopes.length === 0) {
      unscheduled.push({ targetId: target.id, name, priority: target.priority, reason: '无「可用」且配有 CMOS 相机终端的望远镜（维护中/外出的镜子不参与编排）' });
      continue;
    }
    if (!window) {
      unscheduled.push({
        targetId: target.id,
        name,
        priority: target.priority,
        reason: `整夜地平高度均低于阈值 ${target.minAltitude}°，当晚不可见`,
      });
      continue;
    }

    const needMinutes = roundUpStep(target.totalMinutes);
    if (window.endAxis - window.startAxis < needMinutes) {
      unscheduled.push({
        targetId: target.id,
        name,
        priority: target.priority,
        windowText: `${minutesToTime(window.startAxis)}-${minutesToTime(window.endAxis)}`,
        maxAltitude: window.maxAltitude,
        reason: `可见窗口仅 ${window.endAxis - window.startAxis} 分钟（${minutesToTime(window.startAxis)}-${minutesToTime(
          window.endAxis,
        )}，最高 ${window.maxAltitude}°），不足建议累计 ${target.totalMinutes} 分钟`,
      });
      continue;
    }

    const switched = shouldUseNarrowband(target, night.moonPhasePct);
    const filterSlot = switched ? NARROWBAND_FILTER : target.filter;
    const frames = plannedFramesFor(target);

    let chosen: { telescopeId: string; instrumentId: string; start: number; telescopeBusyEnd: number } | null = null;
    for (const telescope of availableTelescopes) {
      const busy = busyByTel.get(telescope.id)!;
      const telescopeBusyEnd = busy.reduce((max, item) => Math.max(max, item.end), horizonStart);
      const intervals = freeIntervals(telescope.id).filter(
        (interval) => Math.min(interval.end, window.endAxis) - Math.max(interval.start, window.startAxis) >= needMinutes,
      );
      for (const interval of intervals) {
        const start = Math.max(interval.start, window.startAxis);
        if (start + needMinutes <= Math.min(interval.end, window.endAxis)) {
          // 多机 EDF：优先最早可行落格（天然先填满一台、溢出再开下一台）；
          // 开始时刻并列时偏向已排得更满的镜子，再并列按编号稳定排序
          if (
            !chosen ||
            start < chosen.start ||
            (start === chosen.start &&
              (telescopeBusyEnd > chosen.telescopeBusyEnd ||
                (telescopeBusyEnd === chosen.telescopeBusyEnd && telescope.code < (telescopes.find((t) => t.id === chosen!.telescopeId)?.code ?? ''))))
          ) {
            chosen = { telescopeId: telescope.id, instrumentId: instrumentByTel.get(telescope.id)!.id, start, telescopeBusyEnd };
          }
        }
      }
    }

    if (!chosen) {
      unscheduled.push({
        targetId: target.id,
        name,
        priority: target.priority,
        windowText: `${minutesToTime(window.startAxis)}-${minutesToTime(window.endAxis)}`,
        maxAltitude: window.maxAltitude,
        reason: `可见窗口 ${minutesToTime(window.startAxis)}-${minutesToTime(window.endAxis)} 内可用望远镜时段均已占满（需连续 ${needMinutes} 分钟）`,
      });
      continue;
    }

    const end = chosen.start + needMinutes;
    const slot: PlannedSlot = {
      targetId: target.id,
      telescopeId: chosen.telescopeId,
      instrumentId: chosen.instrumentId,
      startAxis: chosen.start,
      endAxis: end,
      startTime: minutesToTime(chosen.start),
      endTime: minutesToTime(end),
      filterSlot,
      plannedFrames: frames,
      narrowbandSwitched: switched,
    };
    planned.push(slot);
    busyByTel.get(chosen.telescopeId)!.push({ start: chosen.start, end });
  }

  return { nightId: night.id, planned, unscheduled, signature: buildSignature(input) };
}

/** 编排输入签名：任一会影响编排结果的数据变化才会触发重排 */
export function buildSignature(input: AutoPlanInput): string {
  const { night, targets, telescopes, instruments, nightSessions } = input;
  const nightPart = [
    night.date,
    night.siteLat,
    night.siteLng,
    night.moonPhasePct,
    night.sunset,
    night.sunrise,
  ].join('|');
  const targetPart = targets
    .map((target) =>
      [
        target.id,
        target.raHours,
        target.decDeg,
        target.magnitude,
        target.type,
        target.filter,
        target.exposureSec,
        target.totalMinutes,
        target.priority,
        target.minAltitude,
      ].join(','),
    )
    .join(';');
  const telescopePart = telescopes.map((telescope) => `${telescope.id}:${telescope.code}:${telescope.status}`).join(';');
  const instrumentPart = instruments
    .map((instrument) => `${instrument.id}:${instrument.telescopeCode}:${instrument.terminalType}`)
    .join(';');
  const sessionPart = nightSessions
    .filter((session) => session.status === '已完成' || session.status === '进行中')
    .map((session) =>
      [
        session.id,
        session.targetId,
        session.telescopeId,
        session.startTime,
        session.endTime,
        session.status,
      ].join(','),
    )
    .sort()
    .join(';');
  return [nightPart, targetPart, telescopePart, instrumentPart, sessionPart].join('##');
}

/** 便于页面展示：目标 id → 目标 */
export function targetMap(targets: ObsTarget[]): Map<string, ObsTarget> {
  return new Map(targets.map((target) => [target.id, target]));
}

/** 仅供测试/页面引用：从 store 数据组装 AutoPlanInput */
export function toPlanInput(
  night: ObsNight,
  targets: ObsTarget[],
  telescopes: Telescope[],
  instruments: Instrument[],
  sessions: ObsSession[],
): AutoPlanInput {
  return { night, targets, telescopes, instruments, nightSessions: sessions.filter((session) => session.nightId === night.id) };
}
