'use strict';
const os = require('os');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

// Promesse autour de exec() — ne bloque jamais l'event loop
function execAsync(cmd, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, encoding: 'utf-8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve((stdout || '').trim());
    });
  });
}
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
async function discoverOperators() {
  try {
    const raw = await execAsync(
      `docker ps --filter "name=${PREFIX}" --format "{{.Names}}"`, 5000
    );
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
    const running = await execAsync(
      `docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null`, 3000
    );
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
    const raw = await execAsync(
      `docker exec ${container} bash -c "ss -tlnp 2>/dev/null | grep :7890 | wc -l"`, 3000
    );
    op.smsRelayUp = parseInt(raw) > 0;
  } catch { op.smsRelayUp = false; }

  operators[id] = op;
}

let pollLock = false;
async function pollAll() {
  if (pollLock) { dbg('pollAll skipped: previous poll still running'); return; }
  pollLock = true;
  try {
    activeOpIds = await discoverOperators();
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
  } finally {
    pollLock = false;
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
// Un seul processus tshark -T fields.
// _ws.col.Info → Info Wireshark exacte, sans reconstruction manuelle.
// Hex dump chargé on-demand via packet_hex_request / packet_hex.
//
// Colonnes (séparateur \t, occurrence=f) :
//   0 frame.number   1 frame.time_epoch  2 ip.src       3 ip.dst
//   4 frame.len      5 _ws.col.Protocol  6 _ws.col.Info
//   7 gsmtap.arfcn   8 gsmtap.uplink     9 gsmtap.chan_type
//  10 gsmtap.timeslot 11 gsmtap.frame_nr
//  12 sctp.srcport   13 sctp.dstport    14 frame.protocols
class TsharkSession {
  constructor(ws, clientId) {
    this.ws       = ws;
    this.clientId = clientId;
    this.proc     = null;
    this.running  = false;
    this.buf      = '';
    this.capIface = null;   // mémorisé pour le hex on-demand
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
          if (addr.family === 'IPv4' && addr.address === ip) return iface;
        }
      }
      return null;
    }
    function selectCaptureInterface() {
      if (ENV_CAP_IFACE) { log(`CAP_IFACE forcé: ${ENV_CAP_IFACE}`); return ENV_CAP_IFACE; }
      const gwIface = findIfaceByIp(DOCKER_GW_IP);
      if (gwIface) { log(`Interface auto depuis GW ${DOCKER_GW_IP}: ${gwIface}`); return gwIface; }
      log(`GW ${DOCKER_GW_IP} non trouvée, fallback 'any'`);
      return 'any';
    }

    this.capIface = selectCaptureInterface();

    this.proc = spawn('tshark', [
      '-i', this.capIface,
      '-p',
      '-f', FILTER,
      // Force le dissecteur interne GSMTAP (GSM RR/DTAP) → Info correcte
      '-d', `udp.port==${GSMTAP_UDP},gsmtap`,
      '-T', 'fields',
      '-E', 'header=n',
      '-E', 'separator=\t',
      '-E', 'occurrence=f',
      '-E', 'quote=n',
      '-e', 'frame.number',
      '-e', 'frame.time_epoch',
      '-e', 'ip.src',
      '-e', 'ip.dst',
      '-e', 'frame.len',
      '-e', '_ws.col.Protocol',
      '-e', '_ws.col.Info',
      '-e', 'gsmtap.arfcn',
      '-e', 'gsmtap.uplink',
      '-e', 'gsmtap.chan_type',
      '-e', 'gsmtap.ts',
      '-e', 'gsmtap.frame_nr',
      '-e', 'sctp.srcport',
      '-e', 'sctp.dstport',
      '-e', 'frame.protocols',
      '-l', '-n',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.running = true;
    this.buf = '';
    // Dedup : clé (src|dst|len|ts_100ms) dans une fenêtre glissante de 300 ms
    this.dedupSet = new Map();  // clé → timestamp d'expiration

    this.proc.stdout.on('data', chunk => {
      this.buf += chunk.toString();
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.substring(0, nl);
        this.buf = this.buf.substring(nl + 1);
        if (!line.trim()) continue;
        dbg(`FIELDS: ${line}`);
        const pkt = this.parseLine(line);
        if (pkt) this.sendToClient('packet', pkt);
      }
    });

    this.proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) log(`tshark stderr [${this.clientId}]: ${msg}`);
    });

    this.proc.on('close', code => {
      log(`tshark [${this.clientId}] stopped (code ${code})`);
      if (this.running) { this.running = false; tsharkActiveClients--; broadcastTsharkStatus(); }
      this.sendToClient('tshark_stopped', { code });
    });

    this.proc.on('error', err => {
      log(`tshark [${this.clientId}] error: ${err.message}`);
      if (this.running) { this.running = false; tsharkActiveClients--; broadcastTsharkStatus(); }
      this.sendToClient('tshark_error', { msg: err.message });
    });

    tsharkActiveClients++;
    broadcastTsharkStatus();
  }

  stop() {
    if (this.proc) {
      // SIGINT arrête tshark proprement (flush + stats) ; SIGTERM en fallback
      try { this.proc.kill('SIGINT'); } catch {}
      setTimeout(() => { try { this.proc && this.proc.kill('SIGTERM'); } catch {} }, 500);
      this.proc = null;
    }
    if (this.running) {
      this.running = false;
      if (tsharkActiveClients > 0) tsharkActiveClients--;
      log(`tshark client ${this.clientId} stopped`);
      broadcastTsharkStatus();
    }
  }

  // Chargement on-demand du hex dump pour un numéro de trame précis
  fetchHex(frameNum) {
    if (!this.capIface) return;
    const FILTER = `udp port ${GSMTAP_UDP} or sctp`;
    execAsync(
      `tshark -i ${this.capIface} -p -f "${FILTER}" -T fields ` +
      `-E header=n -E separator=\\t -E occurrence=f -E quote=n ` +
      `-e frame.number -e data.data -c ${frameNum + 200} -n 2>/dev/null | ` +
      `awk -F'\\t' '$1=="${frameNum}" {print $2; exit}'`,
      8000
    ).then(hex => {
      if (hex) this.sendToClient('packet_hex', { frameNum, hex });
    }).catch(() => {});
  }

  parseLine(line) {
    const f = line.split('\t');
    if (f.length < 7) return null;

    const proto  = (f[5] || '').toUpperCase();
    const info   = (f[6] || '').trim();
    const protos = f[14] || '';

    const isGsmtap = protos.includes('gsmtap');
    const isSctp   = protos.includes('sctp') || protos.includes('m3ua');

    if (!isGsmtap && !isSctp) return null;

    // Blacklist bruit TRX/clock
    const BLACKLIST = ['TRX Clock Ind', 'clock jitter', 'GSM clock', 'elapsed_fn'];
    if (BLACKLIST.some(s => info.includes(s))) return null;

    // ── Dedup : même paquet visible sur veth + bridge ─────────
    const now = Date.now();
    const tsMs = Math.round(parseFloat(f[1]) * 1000);
    const dedupKey = `${f[2]}|${f[3]}|${f[4]}|${Math.round(tsMs / 100)}`;
    // Purger les entrées expirées (>300 ms)
    for (const [k, exp] of this.dedupSet) { if (now > exp) this.dedupSet.delete(k); }
    if (this.dedupSet.has(dedupKey)) return null;   // doublon réseau → skip
    this.dedupSet.set(dedupKey, now + 300);
    // ──────────────────────────────────────────────────────────

    const src = f[2] || '';
    const dst = f[3] || '';

    const pkt = {
      id:        ++packetIdGlobal,
      frameNum:  parseInt(f[0]) || 0,
      ts:        parseFloat(f[1]) || 0,
      src, dst,
      protocol:  f[5] || '',
      length:    parseInt(f[4]) || 0,
      info,
      arfcn: '', uplink: false, channel: '', timeslot: '', fn: '',
      hexDump: null, opLabel: '—', direction: '',
    };

    if (isGsmtap) {
      pkt.arfcn    = f[7]  || '';
      pkt.uplink   = f[8]  === '1';
      pkt.channel  = GSMTAP_CHAN[f[9]] || f[9] || '';
      pkt.timeslot = f[10] || '';
      pkt.fn       = f[11] || '';
      pkt.direction = pkt.uplink ? 'UL' : 'DL';
      const arfcn  = parseInt(pkt.arfcn);
      const opNum  = Math.floor((arfcn - 514) / 2) + 1;
      pkt.opLabel  = (opNum >= 1 && opNum <= 24) ? `OP${opNum}` : `A${arfcn}`;
    } else if (isSctp) {
      pkt.sctpPorts = `${f[12]} → ${f[13]}`;
      const ipToOp = ip => {
        const mm = ip && ip.match(/^172\.20\.0\.(\d+)$/);
        if (mm) { const n = parseInt(mm[1]); if (n >= 11) return `OP${n - 10}`; }
        return '';
      };
      const sOp = ipToOp(src), dOp = ipToOp(dst);
      if (sOp && dOp) { pkt.opLabel = `${sOp}/${dOp}`; pkt.direction = `${sOp}→${dOp}`; }
      else if (sOp)   { pkt.opLabel = sOp; pkt.direction = 'UL'; }
      else if (dOp)   { pkt.opLabel = dOp; pkt.direction = 'DL'; }
    }

    return pkt;
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
    // Capture un paquet GSMTAP en fields bruts pour inspecter les noms de champs
    res.writeHead(200, { 'Content-Type': 'application/json' });
    execAsync(
      `tshark -i any -p -f "udp port ${GSMTAP_UDP}" -T fields -E header=y -E separator=\\t ` +
      `-e frame.number -e _ws.col.Protocol -e _ws.col.Info ` +
      `-e gsmtap.arfcn -e gsmtap.chan_type -e gsmtap.uplink ` +
      `-c 1 -n -l 2>/dev/null`, 12000
    ).then(out => res.end(JSON.stringify({ raw: out })))
     .catch(e  => res.end(JSON.stringify({ error: e.message })));
    return;
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
      case 'packet_hex_request': tsharkSession.fetchHex(msg.frameNum); break;
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
httpServer.listen(PORT, async () => {
  const ops = await discoverOperators();
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
