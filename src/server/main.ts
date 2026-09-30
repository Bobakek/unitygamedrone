import { WebSocketServer } from 'ws';
import { createHttpServer } from './http.ts';
import { Game } from './game/game.ts';
import { wsTransport } from './game/session.ts';

// node:sqlite is still flagged experimental; keep the log clean.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if (String(typeof w === 'string' ? w : w.message).includes('SQLite')) return;
  return (emit as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;

const { PilotStore } = await import('./db.ts');

const PORT = Number(process.env.PORT ?? 8080);
const DEV = process.env.DEV === '1';
const store = new PilotStore(process.env.DB_PATH ?? 'data/pilots.db');
const game = new Game({ store, dev: DEV, log: (m) => console.log(`[game] ${m}`) });

const http = createHttpServer(process.env.CLIENT_DIR ?? 'dist/client', () => ({ online: game.sessions.size, tick: game.tick }));
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', (ws) => {
  const conn = game.connect(wsTransport(ws));
  ws.on('message', (data: Buffer) => conn.onMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
  ws.on('close', () => conn.onClose());
  ws.on('error', () => ws.close());
});

game.start();
http.listen(PORT, () => console.log(`Nova Frontier server on http://localhost:${PORT} ${DEV ? '(dev commands enabled)' : ''}`));

const shutdown = () => {
  game.stop();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
