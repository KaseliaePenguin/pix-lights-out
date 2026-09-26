import { systemClock } from '../shared/net/netClock';
import { Track } from '../shared/Track';
import { course1 } from '../shared/tracks/course1';
import { RaceHost } from './RaceHost';
import { WorkerHostTransport } from './WorkerHostTransport';
import type { FromWorkerMessage, ToWorkerMessage } from './workerProtocol';

/**
 * ホストの Web Worker の入口 (network.md「ホストのタブがバックグラウンドに回ったときの対策」)。
 * レース進行・判定・スナップショット (30 回/秒)・ping (1 回/秒) をここのタイマーで進めるので、ホストのタブが裏に回っても止まらない。
 * ホスト時刻はこの Worker の performance.timeOrigin + performance.now() (systemClock)。
 * HostLobby が `new Worker(new URL('./hostWorker.ts', import.meta.url), { type: 'module' })` で起動する。
 */

// lib に WebWorker を入れていないので、使う分だけの形で扱う
const scope = self as unknown as {
  postMessage(msg: FromWorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorkerMessage>) => void) | null;
};

const post = (msg: FromWorkerMessage, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);
const transport = new WorkerHostTransport(post, systemClock);
let host: RaceHost | null = null;

function postStatus(): void {
  if (!host) return;
  post({ kind: 'status', phase: host.phase, canStart: host.canStart, players: host.lobbyPlayers, settings: { ...host.settings } });
}

scope.onmessage = (e) => {
  const msg = e.data;
  if (transport.handleMainMessage(msg)) return;
  switch (msg.kind) {
    case 'init':
      if (host) return;
      // コースは M4 ではコース 1 だけ (Track の生成に約 0.5 秒かかる)
      host = new RaceHost({ transport, clock: systemClock, track: new Track(course1), laps: msg.laps });
      host.onChange = postStatus;
      host.onWarning = (peerId, detail) => post({ kind: 'warning', peerId, detail });
      transport.attachLocal(msg.localPort);
      postStatus();
      break;
    case 'setLaps':
      host?.setLaps(msg.laps);
      break;
    case 'startRace':
      if (host) post({ kind: 'startResult', result: host.startRace() });
      break;
    case 'close':
      host?.close();
      host = null;
      break;
    default:
      break;
  }
};
