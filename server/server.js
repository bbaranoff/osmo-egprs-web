'use strict';
const os = require('os');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');

// ─── Config ──────────────────────────────────────────────────
const PORT       = parseInt(process.env.HTTP_PORT || '80');
const GSMTAP_UDP = parseInt(process.env.GSMTAP_PORT || '4729');
const PREFIX     = process.env.CONTAINER_PREFIX || 'osmo-operator-';
const POLL_MS    = parseInt(process.env.POLL_INTERVAL || '4000');
const VERBOSE    = process.argv.includes('--verbose');

// PulseAudio — for audio streaming to browser
// PULSE_SERVER is set inside containers by start.sh (unix:/run/pulse/native)

const VTY_PORTS = {
  bsc: 4242, msc: 4254, hlr: 4258, mgw: 4243, stp: 4239,
  bts: 4241, ggsn: 4260, sgsn: 4245, pcu: 4240, baseband: 4247,
};

const VTY_RETRY_MAX = 3;
const VTY_RETRY_DELAY = 2000;

function log(...a)  { console.log(`[${new Date().toISOString()}]`, ...a); }
function dbg(...a)  { if (VERBOSE) console.log('[DBG]', ...a); }


// ─── GSMTAP Channel Type Map ─────────────────────────────────
const GSMTAP_CHAN = {
  '0': 'UNKNOWN', '1': 'BCCH', '2': 'CCCH', '3': 'SDCCH4',
  '4': 'SDCCH8', '5': 'BCCH', '6': 'SDCCH', '7': 'TCH/F',
  '8': 'TCH/H', '9': 'PACCH', '10': 'CBCH52', '11': 'PDCH',
  '12': 'PTCCH', '13': 'CBCH51', '128': 'ACCH',
};


// ─── State ───────────────────────────────────────────────────
let operators = {};
let activeOpIds = [];
let packetIdGlobal = 0;
let tsharkActiveClients = 0;

// ─── Docker Discovery ────────────────────────────────────────
function discoverOperators() {
  try {
    const raw = execSync(
      `docker ps --filter "name=${PREFIX}" --format "{{.Names}}"`,
      { timeout: 5000, encoding: 'utf-8' }
    ).trim();
    if (!raw) return [];
    return [...new Set(
      raw.split('\n')
        .map(n => { const m = n.match(new RegExp(`${PREFIX}(\\d+)`)); return m ? parseInt(m[1]) : null; })
        .filter(Boolean)
    )].sort((a, b) => a - b);
  } catch { return activeOpIds; }
}

// ─── VTY via docker exec ─────────────────────────────────────
function dockerExecVty(container, port, commands, ip) {
  const targetIp = ip || '127.0.0.1';
  return new Promise((resolve, reject) => {
    let output = '';
    let done = false;
    const timeout = setTimeout(() => finish(), 8000);

    const proc = spawn('docker', [
      'exec', '-i', container, 'telnet', targetIp, String(port)
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });
    proc.on('error', err => { clearTimeout(timeout); reject(err); });
    proc.on('close', () => finish());

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(output);
    }

    setTimeout(() => {
      for (const cmd of commands) {
        proc.stdin.write(cmd + '\r\n');
      }
      setTimeout(() => {
        proc.stdin.write('exit\r\n');
        proc.stdin.end();
      }, commands.length * 300 + 500);
    }, 600);
  });
}

// ─── VTY Polling ─────────────────────────────────────────────
async function pollOperator(id) {
  const container = `${PREFIX}${id}`;
  const op = operators[id] || { id, online: false, components: {}, mobiles: [] };

  try {
    const running = execSync(
      `docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null`,
      { timeout: 3000, encoding: 'utf-8' }
    ).trim();
    if (running !== 'true') { op.online = false; operators[id] = op; return; }
  } catch { op.online = false; operators[id] = op; return; }

  op.online = true;
  op.lastPoll = Date.now();

  try {
    const raw = await dockerExecVty(container, VTY_PORTS.bsc, ['enable', 'show bts 0']);
    const bts = {};
    let m;
    if ((m = raw.match(/CI\s+(\d+)/i)))               bts.ci = parseInt(m[1], 10);
    if ((m = raw.match(/LAC\s+(\d+)/i)))              bts.lac = parseInt(m[1], 10);
    if ((m = raw.match(/BSIC\s+(\d+)/i)))             bts.bsic = parseInt(m[1], 10);
    if ((m = raw.match(/NCC=(\d+)/i)))                bts.ncc = parseInt(m[1], 10);
    if ((m = raw.match(/BCC=(\d+)/i)))                bts.bcc = parseInt(m[1], 10);
    if ((m = raw.match(/band\s+(\w+)/i)))             bts.band = m[1];
    if ((m = raw.match(/type\s+([\w-]+)/i)))          bts.type = m[1];
    if ((m = raw.match(/(\d+)\s+TRX/i)))              bts.trx_count = parseInt(m[1], 10);
    if ((m = raw.match(/BTS\s+(\d+)/i)))              bts.nr = parseInt(m[1], 10);
    if ((m = raw.match(/ARFCN\s+(\d+)/i)))            bts.arfcn = parseInt(m[1], 10);
    op.components.bts = bts;
  } catch (e) { dbg(`Poll BSC op${id}:`, e.message); }

  try {
    const raw = await dockerExecVty(container, VTY_PORTS.msc, ['enable', 'show subscriber all']);
    op.mobiles = [];
    const lines = raw.split('\n');
    for (const line of lines) {
      const imsiMatch = line.match(/(\d{15})/);
      if (imsiMatch) {
        op.mobiles.push({ imsi: imsiMatch[1], raw: line.trim() });
      }
    }
  } catch (e) { dbg(`Poll MSC op${id}:`, e.message); }

  try {
    const raw = execSync(
      `docker exec ${container} bash -c "ss -tlnp 2>/dev/null | grep :7890 | wc -l"`,
      { timeout: 3000, encoding: 'utf-8' }
    ).trim();
    op.smsRelayUp = parseInt(raw) > 0;
  } catch { op.smsRelayUp = false; }

  operators[id] = op;
}

async function pollAll() {
  activeOpIds = discoverOperators();
  for (const id of Object.keys(operators).map(Number)) {
    if (!activeOpIds.includes(id)) delete operators[id];
  }
  await Promise.allSettled(activeOpIds.map(id => pollOperator(id)));

  const stateMsg = JSON.stringify({
    type: 'state',
    data: { operators, activeOpIds },
    ts: Date.now()
  });

  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(stateMsg);
    }
  }
}

// ─── Interactive VTY Session (with retry) ────────────────────
class VtySession {
  constructor(ws, key, container, port, component, opId, ip) {
    this.ws = ws;
    this.key = key;
    this.container = container;
    this.port = port;
    this.component = component;
    this.opId = opId;
    this.ip = ip || '127.0.0.1';
    this.proc = null;
    this.alive = false;
    this.retries = 0;
    this._connect();
  }

  _connect() {
    log(`VTY open: docker exec -i ${this.container} telnet ${this.ip} ${this.port} (attempt ${this.retries + 1})`);

    this.proc = spawn('docker', [
      'exec', '-i', this.container, 'telnet', this.ip, String(this.port)
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.alive = true;
    let gotData = false;

    this.proc.stdout.on('data', d => {
      gotData = true;
      this._send('vty_data', { key: this.key, data: d.toString() });
    });

    this.proc.stderr.on('data', d => {
      const str = d.toString();
      if (str.includes('Connection refused') || str.includes('Unable to connect')) {
        this.alive = false;
        if (this.retries < VTY_RETRY_MAX) {
          this.retries++;
          this._send('vty_data', {
            key: this.key,
            data: `\r\n--- connection refused, retry ${this.retries}/${VTY_RETRY_MAX} in ${VTY_RETRY_DELAY/1000}s ---\r\n`
          });
          setTimeout(() => this._connect(), VTY_RETRY_DELAY);
          return;
        }
      }
      this._send('vty_data', { key: this.key, data: str });
    });

    this.proc.on('close', code => {
      if (!gotData && this.retries < VTY_RETRY_MAX) {
        this.retries++;
        this._send('vty_data', {
          key: this.key,
          data: `\r\n--- session closed (code ${code}), retry ${this.retries}/${VTY_RETRY_MAX} ---\r\n`
        });
        setTimeout(() => this._connect(), VTY_RETRY_DELAY);
        return;
      }
      this.alive = false;
      this._send('vty_data', { key: this.key, data: `\r\n--- session closed (code ${code}) ---\r\n` });
      this._send('vty_disconnected', { key: this.key });
      log(`VTY closed: ${this.key} (code ${code})`);
    });

    this.proc.on('error', err => {
      this.alive = false;
      this._send('vty_error', { key: this.key, msg: err.message });
    });

    setTimeout(() => {
      if (!this.alive) return;
      this.write('enable');
    }, 1000);

    this._send('vty_connected', {
      key: this.key, opId: this.opId,
      component: this.component, port: this.port,
      retry: this.retries
    });
  }

  write(cmd) {
    if (this.alive && this.proc && this.proc.stdin.writable) {
      this.proc.stdin.write(cmd + '\r\n');
    }
  }

  close() {
    if (this.proc) {
      try { this.proc.stdin.write('exit\r\n'); } catch {}
      setTimeout(() => { try { this.proc.kill('SIGTERM'); } catch {} }, 500);
      this.alive = false;
    }
  }

  _send(type, data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data, ts: Date.now() }));
    }
  }
}

class VtySessionManager {
  constructor(ws) {
    this.ws = ws;
    this.sessions = new Map();
  }

  connect(opId, component, ip) {
    const key = `${opId}-${component}`;
    if (this.sessions.has(key)) {
      this.sessions.get(key).close();
      this.sessions.delete(key);
    }
    const port = VTY_PORTS[component];
    if (!port) return this._send('vty_error', { key, msg: `Unknown component: ${component}` });
    const container = `${PREFIX}${opId}`;
    const session = new VtySession(this.ws, key, container, port, component, opId, ip);
    this.sessions.set(key, session);
  }

  exec(key, cmd) {
    const session = this.sessions.get(key);
    if (!session || !session.alive) {
      return this._send('vty_error', { key, msg: 'Session not connected' });
    }
    session.write(cmd);
  }
 
  disconnect(key) {
    const session = this.sessions.get(key);
    if (session) { session.close(); this.sessions.delete(key); }
    this._send('vty_disconnected', { key });
  }

  closeAll() {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  _send(type, data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data, ts: Date.now() }));
    }
  }
}

// ─── tshark Capture ──────────────────────────────────────────
// Deux processus synchronisés par numéro de trame (robuste vs shift()).
//   proc    : tshark texte  → champ info tel que tshark le formate
//   ekProc  : tshark -T ek  → arfcn, chan_type, uplink, hex dump
// Le texte arrive en premier ; on stocke les EK dans ekMap[frameNum]
// et on fusionne dès que les deux sont disponibles.
class TsharkSession {
  constructor(ws, clientId) {
    this.ws       = ws;
    this.clientId = clientId;
    this.proc     = null;
    this.ekProc   = null;
    this.running  = false;
    this.txtBuf   = '';
    this.ekBuf    = '';
    this.ekMap    = new Map();   // frameNum → ek.layers
    this.txtMap   = new Map();   // frameNum → parsed text pkt
  }

  start() {
    if (this.running) return;
    log(`tshark start for client ${this.clientId}`);

    const FILTER = `udp port ${GSMTAP_UDP} or sctp`;
    const DOCKER_GW_IP = process.env.DOCKER_GW_IP || '172.20.0.1';
    const ENV_CAP_IFACE = process.env.CAP_IFACE || '';
    function findIfaceByIp(ip) {
      const nets = os.networkInterfaces();

      for (const [iface, addrs] of Object.entries(nets)) {
        for (const addr of addrs || []) {
          if (addr.family === 'IPv4' && addr.address === ip) {
            return iface;
          }
        }
      }

      return null;
    }
    function selectCaptureInterface() {
      if (ENV_CAP_IFACE) {
        log(`Capture interface forced by CAP_IFACE=${ENV_CAP_IFACE}`);
        return ENV_CAP_IFACE;
      }

      const gwIface = findIfaceByIp(DOCKER_GW_IP);
      if (gwIface) {
        log(`Capture interface auto-selected from Docker GW ${DOCKER_GW_IP}: ${gwIface}`);
        return gwIface;
      }

      log(`Docker GW ${DOCKER_GW_IP} not found, fallback to 'any'`);
      return 'any';
    }

    const CAP_IFACE = selectCaptureInterface();
    // ── Process texte ────────────────────────────────────────
    this.proc = spawn('tshark', [
      '-i', CAP_IFACE,
      '-p',
      '-f', FILTER,
      '-l',
      '-n',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.ekProc = spawn('tshark', [
      '-i', CAP_IFACE,
      '-p',
      '-f', FILTER,
      '-T', 'ek',
      '-l',
      '-n',
      '-x',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.running = true;
    this.txtBuf = '';
    this.ekBuf  = '';

    // ── Texte → parseTextLine → txtMap → tryMerge ────────────
    this.proc.stdout.on('data', chunk => {
      this.txtBuf += chunk.toString();
      let nl;
      while ((nl = this.txtBuf.indexOf('\n')) !== -1) {
        const line = this.txtBuf.substring(0, nl).trim();
        this.txtBuf = this.txtBuf.substring(nl + 1);
        if (!line) continue;
        dbg(`TXT RAW: ${line}`);
        const parsed = this.parseTextLine(line);
        if (parsed) {
          dbg(`TXT PARSED #${parsed.frameNum}: ${parsed.info}`);
          this.txtMap.set(parsed.frameNum, parsed);
          this.tryMerge(parsed.frameNum);
        }
      }
    });

    this.proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) log(`tshark text stderr [${this.clientId}]: ${msg}`);
    });

    this.proc.on('close', code => {
      log(`tshark text [${this.clientId}] stopped (code ${code})`);
      if (this.running) { this.running = false; tsharkActiveClients--; broadcastTsharkStatus(); }
      this.sendToClient('tshark_stopped', { code });
    });

    this.proc.on('error', err => {
      log(`tshark text [${this.clientId}] error: ${err.message}`);
      if (this.running) { this.running = false; tsharkActiveClients--; broadcastTsharkStatus(); }
      this.sendToClient('tshark_error', { msg: err.message });
    });

    // ── EK → ekMap → tryMerge ────────────────────────────────
    this.ekProc.stdout.on('data', chunk => {
      this.ekBuf += chunk.toString();
      let nl;
      while ((nl = this.ekBuf.indexOf('\n')) !== -1) {
        const line = this.ekBuf.substring(0, nl).trim();
        this.ekBuf = this.ekBuf.substring(nl + 1);
        if (!line || line.startsWith('{"index"')) continue;
        try {
          const ek = JSON.parse(line);
          if (!ek.layers) continue;
          const fnRaw = ek.layers.frame && ek.layers.frame.frame_frame_number;
          const frameNum = Array.isArray(fnRaw) ? parseInt(fnRaw[0]) : parseInt(fnRaw);
          if (!frameNum) continue;
          this.ekMap.set(frameNum, ek.layers);
          this.tryMerge(frameNum);
        } catch {}
      }
    });

    this.ekProc.stderr.on('data', d => { const m = d.toString().trim(); if (m) log(`tshark ek stderr: ${m}`); });
    this.ekProc.on('close', code => { log(`tshark ek closed (code ${code})`); });
    this.ekProc.on('error', err => { log(`tshark ek error: ${err.message}`); });

    tsharkActiveClients++;
    broadcastTsharkStatus();
  }

  // Fusionne texte + EK dès que les deux sont présents pour frameNum.
  // Si EK n'arrive pas dans un délai raisonnable, envoie quand même le texte seul.
  tryMerge(frameNum) {
    const txt = this.txtMap.get(frameNum);
    const ek  = this.ekMap.get(frameNum);
    if (!txt) return;

    if (ek) {
      this.txtMap.delete(frameNum);
      this.ekMap.delete(frameNum);
      const pkt = this.buildPacket(txt, ek);
      if (pkt) this.sendToClient('packet', pkt);
    } else {
      // Fallback : envoyer le texte seul après 500 ms si EK absent
      setTimeout(() => {
        if (!this.txtMap.has(frameNum)) return; // déjà mergé
        this.txtMap.delete(frameNum);
        const pkt = this.buildPacket(txt, null);
        if (pkt) this.sendToClient('packet', pkt);
      }, 500);
    }
  }

  stop() {
    if (this.proc)   { try { this.proc.kill('SIGTERM'); }   catch {} this.proc   = null; }
    if (this.ekProc) { try { this.ekProc.kill('SIGTERM'); } catch {} this.ekProc = null; }
    if (this.running) {
      this.running = false;
      log(`tshark client ${this.clientId} stopped`);
      tsharkActiveClients--;
      broadcastTsharkStatus();
    }
  }

  // Parse une ligne texte tshark :
  //   "  42 1.234567 172.20.0.12 → 172.20.0.1 GSMTAP 83 (BCCH) System Information Type 3"
  parseTextLine(line) {
    const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\S+)\s+(?:→|->)\s+(\S+)\s+(\S+)\s+(\d+)\s*(.*)/);
    if (!m) return null;
    const info = m[7].trim() || m[5];
    // Blacklist bruit TRX/clock
    const BLACKLIST = ['TRX Clock Ind', 'clock jitter', 'GSM clock', 'elapsed_fn'];
    if (BLACKLIST.some(s => info.includes(s))) return null;
    packetIdGlobal++;
    return {
      id: packetIdGlobal,
      frameNum: parseInt(m[1]),
      ts: parseFloat(m[2]),
      src: m[3], dst: m[4],
      protocol: m[5],
      length: parseInt(m[6]),
      info,
    };
  }

  // Construit le paquet final : info du texte, métadonnées GSMTAP/SCTP de l'EK.
  buildPacket(txt, layers) {
    const pkt = {
      id: txt.id, ts: txt.ts,
      src: txt.src, dst: txt.dst,
      protocol: txt.protocol, length: txt.length,
      info: txt.info,           // ← directement de tshark
      arfcn: '', uplink: false,
      channel: '', timeslot: '', fn: '',
      layers: layers || null,
      hexDump: null,
      opLabel: '—', direction: '',
    };

    let hasGsmtap = false, hasSctp = false;

    if (layers) {
      // Hex dump
      const fr = layers.frame;
      if (fr && fr.frame_frame_raw) {
        const r = fr.frame_frame_raw;
        pkt.hexDump = Array.isArray(r) ? r[0] : r;
      }

      // GSMTAP
      if (layers.gsmtap_log) return null; // bruit log OsmoBSC
      const gt = layers.gsmtap;
      if (gt) {
        hasGsmtap    = true;
        pkt.arfcn    = this.getField(gt, 'gsmtap_gsmtap_arfcn');
        pkt.uplink   = this.getField(gt, 'gsmtap_gsmtap_uplink') === '1';
        pkt.channel  = this.getField(gt, 'gsmtap_gsmtap_chan_type');
        pkt.timeslot = this.getField(gt, 'gsmtap_gsmtap_timeslot');
        pkt.fn       = this.getField(gt, 'gsmtap_gsmtap_frame_nr');
        pkt.direction = pkt.uplink ? 'UL' : 'DL';
        const arfcn = parseInt(pkt.arfcn);
        const opNum = Math.floor((arfcn - 514) / 2) + 1;
        pkt.opLabel = (opNum >= 1 && opNum <= 24) ? `OP${opNum}` : `A${arfcn}`;
      }
      if (layers.gsm_trx) return null;

      // SCTP / M3UA
      const sctp = layers.sctp;
      if (sctp) {
        hasSctp = true;
        pkt.protocol = layers.m3ua ? 'M3UA' : 'SCTP';
        const sp = this.getField(sctp, 'sctp_sctp_srcport');
        const dp = this.getField(sctp, 'sctp_sctp_dstport');
        pkt.sctpPorts = `${sp} → ${dp}`;
        const ipToOp = ip => {
          const mm = ip && ip.match(/^172\.20\.0\.(\d+)$/);
          if (mm) { const n = parseInt(mm[1]); if (n >= 11) return `OP${n - 10}`; }
          return '';
        };
        const sOp = ipToOp(txt.src), dOp = ipToOp(txt.dst);
        if (sOp && dOp) { pkt.opLabel = `${sOp}/${dOp}`; pkt.direction = `${sOp}→${dOp}`; }
        else if (sOp)   { pkt.opLabel = sOp; pkt.direction = 'UL'; }
        else if (dOp)   { pkt.opLabel = dOp; pkt.direction = 'DL'; }
      }
    } else {
      // Pas d'EK : déduire depuis le texte
      hasGsmtap = txt.protocol.toUpperCase().includes('GSMTAP');
      hasSctp   = txt.protocol.toUpperCase().includes('SCTP') || txt.protocol.toUpperCase().includes('M3UA');
    }

    if (!hasGsmtap && !hasSctp) return null;
    return pkt;
  }

  getField(layer, field) {
    if (!layer) return '';
    const v = layer[field];
    return Array.isArray(v) ? v[0] || '' : v || '';
  }

  sendToClient(type, data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data, ts: Date.now() }));
    }
  }
}

function broadcastTsharkStatus() {
  const statusMsg = JSON.stringify({
    type: 'tshark_status',
    data: { active: tsharkActiveClients > 0, clientCount: tsharkActiveClients },
    ts: Date.now()
  });
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(statusMsg);
    }
  }
}

// ─── HTTP Server ─────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
};
const webDir = path.join(__dirname, 'web');

const httpServer = http.createServer((req, res) => {
  // ── /audio : stream MP3 depuis le FIFO du container ─────────
  if (req.url === '/audio') {
    // Tuer le drain, lancer ffmpeg
    stopDrain();
    stopAudioFfmpeg();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Transfer-Encoding', 'chunked');
    audioFfmpeg = spawn('docker', [
      'exec', AUDIO_CONTAINER,
      'ffmpeg', '-f', 's16le', '-ar', '8000', '-ac', '1',
      '-i', AUDIO_FIFO,
      '-acodec', 'libmp3lame', '-b:a', '8k',
      '-f', 'mp3', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    audioFfmpeg.stdout.pipe(res);
    audioFfmpeg.on('close', () => { audioFfmpeg = null; startDrain(); });
    audioFfmpeg.on('error', () => { audioFfmpeg = null; startDrain(); });
    req.on('close', () => { stopAudioFfmpeg(); startDrain(); });
    log('Audio: client connecté → ffmpeg démarré');
    return;
  }

  if (req.url === '/api/debug-ek') {
    // Capture un paquet GSMTAP en EK brut pour inspecter les noms de champs
    const { execSync: ex } = require('child_process');
    try {
      const out = ex(
        `tshark -i any -p -f "udp port ${GSMTAP_UDP}" -T ek -c 1 -n -l`,
        { timeout: 12000, encoding: 'utf-8', shell: true }
      ).trim();
      // tshark -T ek émet une ligne {"index":...} puis une ligne {"layers":...}
      const layersLine = out.split('\n').find(l => l.includes('"layers"'));
      if (!layersLine) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'no packet captured', raw: out }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(layersLine);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }


  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ operators, activeOpIds, tsharkActive: tsharkActiveClients > 0 }));
  }

  let fp = req.url === '/' ? '/index.html' : req.url;
  fp = path.join(webDir, fp);
  const ct = MIME[path.extname(fp)] || 'application/octet-stream';
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
});

// ─── WebSocket Server ────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
const clients = new Set();

wss.on('connection', (ws, req) => {
  log(`Client connected from ${req.socket.remoteAddress}`);
  const clientId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  const vtyMgr = new VtySessionManager(ws);
  const tsharkSession = new TsharkSession(ws, clientId);
  const clientObj = { ws, vtyMgr, tsharkSession, clientId, audioActive: false };
  clients.add(clientObj);

  ws.send(JSON.stringify({
    type: 'init',
    data: {
      operators, activeOpIds, vtyPorts: VTY_PORTS,
      tsharkActive: tsharkActiveClients > 0
    },
    ts: Date.now(),
  }));

  ws.on('message', raw => {
    // Binary frames ignored (we only send binary)
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'vty_connect':   vtyMgr.connect(msg.opId, msg.component, msg.ip); break;
      case 'vty_exec':      vtyMgr.exec(msg.key, msg.cmd); break;
      case 'vty_disconnect': vtyMgr.disconnect(msg.key); break;
      case 'tshark_start':  tsharkSession.start(); break;
      case 'tshark_stop':   tsharkSession.stop(); break;
      case 'poll':          pollAll(); break;
    }
  });

  ws.on('close', () => {
    clients.delete(clientObj);
    vtyMgr.closeAll();
    tsharkSession.stop();
    stopAudio(clientObj);
    log(`Client ${clientId} disconnected`);
  });
});

// ─── Audio: FIFO → ffmpeg MP3 → HTTP /audio ──────────────────
// Architecture :
//   mobile → ALSA type file → /tmp/gsm-audio.fifo (dans le container)
//   drain  : cat > /dev/null (maintient le FIFO ouvert quand pas de client)
//   client : GET /audio → docker exec ffmpeg lit le FIFO → MP3 stream
//
// Un seul client audio à la fois (FIFO = flux unique).
// Le drain est tué quand un client se connecte, relancé à sa déconnexion.

const AUDIO_FIFO      = process.env.AUDIO_FIFO || '/tmp/gsm-audio.fifo';
const AUDIO_CONTAINER = `${PREFIX}1`;

let audioDrain  = null;   // cat drain
let audioFfmpeg = null;   // ffmpeg actif

function startDrain() {
  if (audioDrain) return;
  audioDrain = spawn('docker', [
    'exec', AUDIO_CONTAINER,
    'sh', '-c', `cat ${AUDIO_FIFO} > /dev/null`
  ], { stdio: 'ignore' });
  audioDrain.on('close', () => { audioDrain = null; });
  audioDrain.on('error', () => { audioDrain = null; });
  log('Audio: drain FIFO démarré');
}

function stopDrain() {
  if (audioDrain) {
    try { audioDrain.kill('SIGTERM'); } catch {}
    audioDrain = null;
  }
}

function stopAudioFfmpeg() {
  if (audioFfmpeg) {
    try { audioFfmpeg.kill('SIGTERM'); } catch {}
    audioFfmpeg = null;
  }
}

function ensureAudioDrain() {
  if (!audioDrain && !audioFfmpeg) startDrain();
}

// ─── Boot ────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  const ops = discoverOperators();
  activeOpIds = ops;
  log(`osmo-egprs-web listening on :${PORT}`);
  ensureAudioDrain();
  log(`Operators: [${ops.join(', ')}] (${ops.length})`);
  log(`Capture filter: udp port ${GSMTAP_UDP} or sctp`);
});

setInterval(pollAll, POLL_MS);
setTimeout(pollAll, 1500);

process.on('SIGINT', () => {
  log('Shutting down');
  for (const client of clients) {
    client.tsharkSession.stop();
    client.vtyMgr.closeAll();
  }
  stopAudioFfmpeg(); startDrain();
  wss.close();
  httpServer.close();
  process.exit(0);
});
