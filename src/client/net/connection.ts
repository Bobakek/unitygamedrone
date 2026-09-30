import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import {
  decodeJson, decodeShots, decodeSnapshot, encodeInput, encodeJson, MSG,
  type Action, type EntityInfo, type GameEvent, type InputMsg, type PilotInfo, type Shot, type Snapshot, type Welcome,
} from '../../shared/net/protocol.ts';

export interface NetHandlers {
  welcome(w: Welcome): void;
  snapshot(s: Snapshot): void;
  info(list: EntityInfo[]): void;
  gone(ids: number[]): void;
  shots(s: Shot[]): void;
  events(ev: GameEvent[]): void;
  pilot(p: PilotInfo): void;
  error(message: string): void;
  closed(): void;
}

/** WebSocket client speaking the binary/JSON protocol. */
export class Connection {
  private ws: WebSocket;
  rtt = 0.1;

  constructor(url: string, name: string, token: string | undefined, private h: NetHandlers) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.ws.send(encodeJson(MSG.HELLO, { v: PROTOCOL_VERSION, name, token }));
      setInterval(() => this.sendJson(MSG.PING, { c: performance.now() }), 2000);
    };
    this.ws.onmessage = (e) => this.onMessage(new Uint8Array(e.data as ArrayBuffer));
    this.ws.onclose = () => h.closed();
  }

  private onMessage(d: Uint8Array) {
    switch (d[0]) {
      case MSG.SNAPSHOT: this.h.snapshot(decodeSnapshot(d)); break;
      case MSG.SHOTS: this.h.shots(decodeShots(d)); break;
      case MSG.EVENTS: this.h.events(decodeJson<{ ev: GameEvent[] }>(d).ev); break;
      case MSG.INFO: this.h.info(decodeJson<{ list: EntityInfo[] }>(d).list); break;
      case MSG.GONE: this.h.gone(decodeJson<{ ids: number[] }>(d).ids); break;
      case MSG.PILOT: this.h.pilot(decodeJson<PilotInfo>(d)); break;
      case MSG.WELCOME: this.h.welcome(decodeJson<Welcome>(d)); break;
      case MSG.ERROR: this.h.error(decodeJson<{ message: string }>(d).message); break;
      case MSG.PONG: {
        const p = decodeJson<{ c: number }>(d);
        this.rtt = this.rtt * 0.8 + ((performance.now() - p.c) / 1000) * 0.2;
        break;
      }
    }
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
