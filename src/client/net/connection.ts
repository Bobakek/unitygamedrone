import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import {
  decodeJson, decodeShots, decodeSnapshot, encodeInput, encodeJson, MSG,
  type Action, type EntityInfo, type GameEvent, type InputMsg, type PilotInfo, type Shot, type Snapshot, type Welcome,
} from '../../shared/net/protocol.ts';
import type { Poi } from '../../shared/events.ts';

export interface NetHandlers {
  welcome(w: Welcome): void;
  snapshot(s: Snapshot): void;
  info(list: EntityInfo[]): void;
  gone(ids: number[]): void;
  shots(s: Shot[]): void;
  events(ev: GameEvent[]): void;
  pilot(p: PilotInfo): void;
  world(pois: Poi[]): void;
  error(message: string): void;
  closed(): void;
}

/** What the game needs from a connection — a real WebSocket or the in-browser offline server. */
export interface NetClient {
  readonly open: boolean;
  rtt: number;
  input(m: InputMsg): void;
  action(a: Action): void;
  chat(text: string): void;
}

/** Decodes one server message and routes it to the handlers. Returns PONG payloads. */
export function dispatchMessage(d: Uint8Array, h: NetHandlers): { c: number } | null {
  switch (d[0]) {
    case MSG.SNAPSHOT: h.snapshot(decodeSnapshot(d)); break;
    case MSG.SHOTS: h.shots(decodeShots(d)); break;
    case MSG.EVENTS: h.events(decodeJson<{ ev: GameEvent[] }>(d).ev); break;
    case MSG.INFO: h.info(decodeJson<{ list: EntityInfo[] }>(d).list); break;
    case MSG.GONE: h.gone(decodeJson<{ ids: number[] }>(d).ids); break;
    case MSG.PILOT: h.pilot(decodeJson<PilotInfo>(d)); break;
    case MSG.WORLD: h.world(decodeJson<{ pois: Poi[] }>(d).pois); break;
    case MSG.WELCOME: h.welcome(decodeJson<Welcome>(d)); break;
    case MSG.ERROR: h.error(decodeJson<{ message: string }>(d).message); break;
    case MSG.PONG: return decodeJson<{ c: number }>(d);
  }
  return null;
}

export const helloMessage = (name: string, token: string | undefined) => encodeJson(MSG.HELLO, { v: PROTOCOL_VERSION, name, token });

/** WebSocket client speaking the binary/JSON protocol. */
export class Connection implements NetClient {
  private ws: WebSocket;
  rtt = 0.1;

  constructor(url: string, name: string, token: string | undefined, private h: NetHandlers) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.ws.send(helloMessage(name, token));
      setInterval(() => this.sendJson(MSG.PING, { c: performance.now() }), 2000);
    };
    this.ws.onmessage = (e) => {
      const pong = dispatchMessage(new Uint8Array(e.data as ArrayBuffer), this.h);
      if (pong) this.rtt = this.rtt * 0.8 + ((performance.now() - pong.c) / 1000) * 0.2;
    };
    this.ws.onclose = () => h.closed();
  }

  get open() {
    return this.ws.readyState === WebSocket.OPEN;
  }

  private sendJson(type: number, payload: unknown) {
    if (this.open) this.ws.send(encodeJson(type, payload));
  }

  input(m: InputMsg) {
    if (this.open) this.ws.send(encodeInput(m));
  }

  action(a: Action) {
    this.sendJson(MSG.ACTION, a);
  }

  chat(text: string) {
    this.sendJson(MSG.CHAT, { text });
  }
}
