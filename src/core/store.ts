import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { LogEvent, State } from './types.ts';

const MAX_EVENTS_IN_MEMORY = 2000;

export const newId = (): string => randomUUID().slice(0, 8);
export const now = (): string => new Date().toISOString();
/** サーバーのローカル時刻での 'YYYY-MM'。 */
export const monthKey = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/**
 * 状態の保存と変更通知。状態は state.json、イベントログは events.jsonl に書く。
 * 'change' は状態が変わったとき、'event' はログが追加されたときに発火する。
 */
export class Store extends EventEmitter {
  readonly state: State;
  private events: LogEvent[] = [];
  private readonly statePath?: string;
  private readonly eventsPath?: string;
  private saveTimer?: NodeJS.Timeout;

  /** dataDir を省略するとメモリ上だけで動く(テスト用)。 */
  constructor(dataDir?: string) {
    super();
    this.state = { businesses: [], projects: [], tasks: [], approvals: [] };
    if (!dataDir) return;
    mkdirSync(dataDir, { recursive: true });
    this.statePath = join(dataDir, 'state.json');
    this.eventsPath = join(dataDir, 'events.jsonl');
    if (existsSync(this.statePath)) {
      Object.assign(this.state, JSON.parse(readFileSync(this.statePath, 'utf8')));
      // 古い形式の state.json からの移行
      for (const p of this.state.projects) p.spendByMonth ??= {};
    }
    if (existsSync(this.eventsPath)) {
      const lines = readFileSync(this.eventsPath, 'utf8').trim().split('\n').filter(Boolean);
      this.events = lines.slice(-MAX_EVENTS_IN_MEMORY).map((l) => JSON.parse(l) as LogEvent);
    }
  }

  /** 状態を変更した後に呼ぶ。保存はまとめて行う。 */
  changed(): void {
    this.emit('change');
    if (!this.statePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, 200);
  }

  flush(): void {
    if (!this.statePath) return;
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.statePath);
  }

  log(e: Omit<LogEvent, 'id' | 'ts'>): LogEvent {
    const event: LogEvent = { id: newId(), ts: now(), ...e };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS_IN_MEMORY) this.events.shift();
    if (this.eventsPath) appendFileSync(this.eventsPath, JSON.stringify(event) + '\n');
    this.emit('event', event);
    return event;
  }

  recentEvents(projectId?: string, limit = 300): LogEvent[] {
    const list = projectId ? this.events.filter((e) => e.projectId === projectId) : this.events;
    return list.slice(-limit);
  }
}
