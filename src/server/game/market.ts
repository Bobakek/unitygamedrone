import { CARGO_KEYS, CARGO_NAMES, type CargoKey } from '../../shared/economy.ts';
import { boardEpoch, BOARD_EPOCH_MS, holdRoom } from '../../shared/contracts.ts';
import { MARKET_HALF_LIFE, marketQuote, type MarketMsg, type MarketQuote } from '../../shared/market.ts';
import { MSG } from '../../shared/net/protocol.ts';
import type { Session } from './session.ts';
import type { SystemInstance } from './system.ts';

/** Most units moved in one trade. */
const MAX_LOT = 100;

/**
 * The station market of a system: prices from the shared market model plus the memory of
 * recent trade (units sold minus bought per good, fading with game time). The fade is
 * worked out when the market is looked at, so a system nobody visits costs nothing.
 */
export class StationMarket {
  private pressure: Record<CargoKey, number> = { ore: 0, crystal: 0, relic: 0, bio: 0 };
  private at = 0;
  /** Quote last sent to docked pilots (to resend only on a change). */
  private sent = '';

  constructor(private sys: SystemInstance) {}

  private decay() {
    const dt = this.sys.time - this.at;
    this.at = this.sys.time;
    if (dt <= 0) return;
    const k = Math.pow(0.5, dt / MARKET_HALF_LIFE);
    for (const c of CARGO_KEYS) this.pressure[c] *= k;
  }

  quote(): MarketQuote {
    this.decay();
    return marketQuote(this.sys.def.id, boardEpoch(this.sys.now()), this.pressure);
  }

  /** This station's prices and those of the systems its gates lead to. */
  msg(others: MarketQuote[]): MarketMsg {
    const ep = boardEpoch(this.sys.now());
    return { here: this.quote(), others, next: (ep + 1) * BOARD_EPOCH_MS - this.sys.now() };
  }

  /** Sells `n` units of `key` (all of it when n is absent; everything when key is absent too). */
  sell(s: Session, key?: CargoKey, n?: number): string | null {
    const p = s.pilot;
    const keys = key ? [key] : CARGO_KEYS;
    let sum = 0, units = 0;
    for (const k of keys) {
      const have = p.cargo[k];
      const lot = Math.min(have, n === undefined || !Number.isFinite(n) ? have : Math.max(0, Math.floor(n)), MAX_LOT);
      // price units one by one, so a big lot pushes its own price down
      for (let i = 0; i < lot; i++) {
        sum += this.quote().goods[k].sell;
        this.pressure[k]++;
      }
      p.cargo[k] -= lot;
      units += lot;
    }
    if (!units) return 'Трюм пуст';
    p.credits += sum;
    s.sendPilot();
    s.msg(key ? `Продано: ${CARGO_NAMES[key].toLowerCase()} ×${units} — +${sum} кр` : `Груз продан: +${sum} кр`, 'good');
    return null;
  }

  buy(s: Session, key: CargoKey, n: number): string | null {
    const p = s.pilot;
    if (!this.quote().goods[key].buy) return 'Станция это не продаёт';
    const room = holdRoom(p);
    if (room <= 0) return 'Трюм полон';
    const want = Math.min(room, Math.max(1, Math.floor(n) || 1), MAX_LOT);
    let cost = 0, got = 0;
    for (; got < want; got++) {
      const price = this.quote().goods[key].buy!;
      if (p.credits < cost + price) break;
      cost += price;
      this.pressure[key]--;
    }
    if (!got) return 'Недостаточно кредитов';
    p.credits -= cost;
    p.cargo[key] += got;
    s.sendPilot();
    s.msg(`Куплено: ${CARGO_NAMES[key].toLowerCase()} ×${got} — −${cost} кр`, 'good');
    return null;
  }

  /** Did the prices change since they were last broadcast? */
  changed(): boolean {
    const q = JSON.stringify(this.quote().goods);
    if (q === this.sent) return false;
    this.sent = q;
    return true;
  }

  send(s: Session, others: MarketQuote[]) {
    s.sendJson(MSG.MARKET, this.msg(others));
  }
}
