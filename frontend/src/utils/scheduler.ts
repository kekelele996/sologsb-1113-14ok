import type { FilterName, Instrument, ObsNight, ObsSession, ObsTarget, Telescope } from '../types';
import { SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { axisMinutes, minutesToTime, visibilityWindow } from './astro';

/** 月相偏亮阈值（与 astro.moonConflict 的「月相偏亮」口径一致） */
const BRIGHT_MOON_THRESHOLD = 60;
/** 暗目标（暗星等）阈值：视星等越大越暗 */
const DARK_TARGET_MAGNITUDE = 8;
const NARROWBAND_FILTERS: FilterName[] = ['Ha', 'OIII', 'SII'];

export interface ScheduleFailure {
  targetId: string;
  targetName: string;
  reason: string;
}

export interface ScheduledItem {
  targetId: string;
  telescopeId: string;
  instrumentId: string;
  startTime: string;
  endTime: string;
  filterSlot: string;
  plannedFrames: number;
  /** 是否因月相偏亮而改用窄带滤镜 */
  changedFilter: boolean;
}

export interface ScheduleResult {
  items: ScheduledItem[];
  failures: ScheduleFailure[];
}

interface Interval {
  start: number;
  end: number;
}

function isNarrowband(filter: FilterName): boolean {
  return NARROWBAND_FILTERS.includes(filter);
}

/** 月相偏亮且目标偏暗时，暗目标改用窄带滤镜（已有窄带则保留） */
export function effectiveFilter(target: ObsTarget, night: ObsNight): { filter: FilterName; changed: boolean } {
  const bright = night.moonPhasePct >= BRIGHT_MOON_THRESHOLD;
  const dark = target.magnitude >= DARK_TARGET_MAGNITUDE;
  if (bright && dark) {
    if (isNarrowband(target.filter)) return { filter: target.filter, changed: false };
    return { filter: 'Ha', changed: true };
  }
  return { filter: target.filter, changed: false };
}

function overlap(a: Interval, b: Interval): boolean {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0;
}

/** 在 [winStart, winEnd] 内找最早的、能放下 duration 分钟的空闲时段 */
function findEarliestSlot(winStart: number, winEnd: number, duration: number, occupied: Interval[]): number | null {
  if (winEnd - winStart < duration) return null;
  const candidates = [winStart, ...occupied.map((item) => item.end).filter((end) => end > winStart && end < winEnd)];
  for (const start of candidates.sort((a, b) => a - b)) {
    if (start < winStart || start + duration > winEnd) continue;
    if (!occupied.some((item) => overlap({ start, end: start + duration }, item))) return start;
  }
  return null;
}

/** 为望远镜挑选终端：优先 CMOS 相机，其次该镜适配的任意终端 */
function pickInstrument(telescopeCode: string, instruments: Instrument[]): Instrument | undefined {
  return (
    instruments.find((item) => item.telescopeCode === telescopeCode && item.terminalType === 'CMOS 相机') ??
    instruments.find((item) => item.telescopeCode === telescopeCode)
  );
}

function priorityRank(priority: string): number {
  return priority === 'P1' ? 0 : priority === 'P2' ? 1 : 2;
}

/**
 * 本夜编排：按目标最低高度与当晚可见窗口，把待观测目标排成一条不撞车的序列。
 * - 仅「可用」望远镜参与，维护中 / 外出的镜子不参与
 * - 优先排 P1，再排窗口快结束的（同优先级按窗口结束时刻升序）
 * - 月相偏亮时暗目标改用窄带滤镜
 * - 排不进去的目标连原因一并返回（不写入）
 */
export function buildNightSchedule(
  night: ObsNight,
  targets: ObsTarget[],
  telescopes: Telescope[],
  instruments: Instrument[],
  existingSessions: ObsSession[],
): ScheduleResult {
  const items: ScheduledItem[] = [];
  const failures: ScheduleFailure[] = [];

  const available = telescopes
    .filter((telescope) => telescope.status === '可用')
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code));

  // 待观测目标：本夜尚无排程段的目标（重复编排不重排已排目标）
  const scheduledTargetIds = new Set(
    existingSessions.filter((session) => session.nightId === night.id).map((session) => session.targetId),
  );
  const candidates = targets.filter((target) => !scheduledTargetIds.has(target.id));

  if (available.length === 0) {
    for (const target of candidates) {
      failures.push({
        targetId: target.id,
        targetName: target.name,
        reason: '无可用望远镜（维护中或外出的镜子不参与编排）',
      });
    }
    return { items, failures };
  }

  const withWindows = candidates.map((target) => ({ target, win: visibilityWindow(target, night) }));

  // 排序：P1 优先，再排窗口快结束的（窗口结束轴升序），最后按名称稳定排序
  withWindows.sort((a, b) => {
    const pa = priorityRank(a.target.priority);
    const pb = priorityRank(b.target.priority);
    if (pa !== pb) return pa - pb;
    const ea = a.win ? axisMinutes(a.win.endText) : Number.POSITIVE_INFINITY;
    const eb = b.win ? axisMinutes(b.win.endText) : Number.POSITIVE_INFINITY;
    if (ea !== eb) return ea - eb;
    return a.target.name.localeCompare(b.target.name);
  });

  // 每台可用望远镜的占用区间（已有排程 + 本次排入）
  const occupiedByTelescope = new Map<string, Interval[]>();
  for (const telescope of available) occupiedByTelescope.set(telescope.id, []);
  for (const session of existingSessions.filter((item) => item.nightId === night.id)) {
    if (!occupiedByTelescope.has(session.telescopeId)) continue;
    const start = axisMinutes(session.startTime);
    let end = axisMinutes(session.endTime);
    if (end <= start) end += 1440;
    occupiedByTelescope.get(session.telescopeId)!.push({ start, end });
  }

  for (const { target, win } of withWindows) {
    if (!win) {
      failures.push({
        targetId: target.id,
        targetName: target.name,
        reason: `本夜不可见：地平高度始终低于阈值 ${target.minAltitude}°`,
      });
      continue;
    }
    const winStart = axisMinutes(win.startText);
    const winEnd = axisMinutes(win.endText);
    const duration = target.totalMinutes;
    if (winEnd - winStart < duration) {
      failures.push({
        targetId: target.id,
        targetName: target.name,
        reason: `可见窗口仅 ${win.durationMinutes} 分钟，不足建议累计 ${duration} 分钟`,
      });
      continue;
    }

    // 选能放下的最早时段（并列按望远镜编号），保证整条序列不撞车
    let chosen: { telescopeId: string; instrumentId: string; start: number } | null = null;
    for (const telescope of available) {
      const instrument = pickInstrument(telescope.code, instruments);
      if (!instrument) continue;
      const start = findEarliestSlot(winStart, winEnd, duration, occupiedByTelescope.get(telescope.id)!);
      if (start === null) continue;
      if (!chosen || start < chosen.start) {
        chosen = { telescopeId: telescope.id, instrumentId: instrument.id, start };
      }
    }

    if (!chosen) {
      failures.push({
        targetId: target.id,
        targetName: target.name,
        reason: `窗口（${win.startText}-${win.endText}）内无空闲望远镜时段`,
      });
      continue;
    }

    const { filter, changed } = effectiveFilter(target, night);
    const plannedFrames =
      target.exposureSec > 0 ? Math.max(1, Math.round((duration * 60) / target.exposureSec)) : Math.max(1, duration);

    items.push({
      targetId: target.id,
      telescopeId: chosen.telescopeId,
      instrumentId: chosen.instrumentId,
      startTime: minutesToTime(chosen.start),
      endTime: minutesToTime(chosen.start + duration),
      filterSlot: filter,
      plannedFrames,
      changedFilter: changed,
    });
    occupiedByTelescope.get(chosen.telescopeId)!.push({ start: chosen.start, end: chosen.start + duration });
  }

  return { items, failures };
}

/** 把编排结果转换为待写入的排程段输入（状态统一为「待执行」） */
export function scheduleItemsToSessions(
  nightId: string,
  items: ScheduledItem[],
): Array<{
  nightId: string;
  targetId: string;
  startTime: string;
  endTime: string;
  telescopeId: string;
  instrumentId: string;
  filterSlot: string;
  plannedFrames: number;
  status: '待执行';
  schemaVersion: number;
}> {
  return items.map((item) => ({
    nightId,
    targetId: item.targetId,
    startTime: item.startTime,
    endTime: item.endTime,
    telescopeId: item.telescopeId,
    instrumentId: item.instrumentId,
    filterSlot: item.filterSlot,
    plannedFrames: item.plannedFrames,
    status: '待执行',
    schemaVersion: SCHEMA_VERSION,
  }));
}
