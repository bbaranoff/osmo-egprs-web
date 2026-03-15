'use strict';

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
const REAL_UID   = process.env.SUDO_UID || process.env.UID || '1000';
const PULSE_SRV  = process.env.PULSE_SERVER || `/run/user/${REAL_UID}/pulse/native`;
const AUDIO_SINK = process.env.AUDIO_SINK || 'gsm_audio.monitor';

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

const GSMTAP_CHAN_SUBTYPES = {
  '0x0000': 'BCCH', '0x0001': 'CCCH', '0x0002': 'SDCCH/4',
  '0x0004': 'SDCCH/8', '0x0008': 'FACCH/F', '0x0009': 'FACCH/H',
  '0x000a': 'SACCH/TF', '0x000b': 'SACCH/TH',
};

// GSM A RR message type names
const RR_MSG_TYPES = {
  '0': 'System Information Type 13',
  '1': 'System Information Type 14',
  '2': 'System Information Type 2bis',
  '3': 'System Information Type 2ter',
  '6': 'System Information Type 9',
  '13': 'Channel Release',
  '21': 'Measurement Report',
  '25': 'System Information Type 5',
  '26': 'System Information Type 5bis',
  '27': 'System Information Type 5ter',
  '28': 'System Information Type 6',
  '29': 'Paging Response',
  '32': 'Paging Request Type 1',
  '33': 'Paging Request Type 2',
  '34': 'Paging Request Type 3',
  '35': 'Assignment Command',
  '41': 'Immediate Assignment',
  '57': 'Ciphering Mode Command',
  '59': 'System Information Type 1',
  '26': 'System Information Type 2',
  '27': 'System Information Type 3',
  '28': 'System Information Type 4',
  '63': 'Handover Command',
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

// ─── tshark Capture: GSMTAP + SCTP with text parse ──────────
class TsharkSession {
  constructor(ws, clientId) {
    this.ws = ws;
    this.clientId = clientId;
    this.proc = null;
    this.ekProc = null;
    this.running = false;
    this.buffer = '';
    this.ekBuffer = '';
    this.ekPackets = [];  // queue of parsed ek JSON packets
    this.textPackets = []; // queue of parsed text summary lines
  }

  start() {
    if (this.running) return;
    log(`tshark start for client ${this.clientId}`);
    this.running = true;

    // Process 1: tshark text output for nice summary lines
    this.proc = spawn('tshark', [
      '-i', 'any',
      '-f', `udp port ${GSMTAP_UDP} or sctp`,
      '-l',
      '-n',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    // Process 2: tshark -T ek for JSON dissection + hex
    this.ekProc = spawn('tshark', [
      '-i', 'any',
      '-f', `udp port ${GSMTAP_UDP} or sctp`,
      '-T', 'ek',
      '-l',
      '-n',
      '-x',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.buffer = '';
    this.ekBuffer = '';

    // Text output: parse one-line summaries
    this.proc.stdout.on('data', chunk => {
      this.buffer += chunk.toString();
      let nl;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.substring(0, nl).trim();
        this.buffer = this.buffer.substring(nl + 1);
        if (!line) continue;
        const parsed = this.parseTextLine(line);
        if (parsed) {
          // Try to match with an ek packet for dissection
          const ek = this.ekPackets.shift();
          const packet = this.mergePacket(parsed, ek);
          if (packet) this.sendToClient('packet', packet);
        }
      }
    });

    this.proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg && !msg.startsWith('Capturing on')) {
        this.sendToClient('tshark_log', { msg });
      }
    });

    this.proc.on('close', (code) => {
      log(`tshark text client ${this.clientId} stopped (code ${code})`);
      this.running = false;
      this.sendToClient('tshark_stopped', { code });
      tsharkActiveClients--;
      broadcastTsharkStatus();
    });

    this.proc.on('error', (err) => {
      log(`tshark text client ${this.clientId} error:`, err.message);
      this.running = false;
      this.sendToClient('tshark_error', { msg: err.message });
      tsharkActiveClients--;
      broadcastTsharkStatus();
    });

    // EK JSON output: parse for dissection data
    this.ekProc.stdout.on('data', chunk => {
      this.ekBuffer += chunk.toString();
      let nl;
      while ((nl = this.ekBuffer.indexOf('\n')) !== -1) {
        const line = this.ekBuffer.substring(0, nl).trim();
        this.ekBuffer = this.ekBuffer.substring(nl + 1);
        if (!line || line.startsWith('{"index"')) continue;
        try {
          const pkt = JSON.parse(line);
          if (pkt.layers) {
            // Drop TRX Clock / jitter noise (same filter as text parser)
            const flen = pkt.layers.frame && pkt.layers.frame.frame_frame_len;
            const frameLen = Array.isArray(flen) ? parseInt(flen[0]) : parseInt(flen);
            if (frameLen === 210 || frameLen === 184 || frameLen === 185) continue;
            this.ekPackets.push(pkt);
            while (this.ekPackets.length > 50) this.ekPackets.shift();
          }
        } catch {}
      }
    });

    this.ekProc.stderr.on('data', () => {}); // ignore
    this.ekProc.on('close', () => {});
    this.ekProc.on('error', () => {});

    tsharkActiveClients++;
    broadcastTsharkStatus();
  }

  stop() {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    if (this.ekProc) {
      this.ekProc.kill('SIGTERM');
      this.ekProc = null;
    }
    if (this.running) {
      this.running = false;
      log(`tshark client ${this.clientId} stopped`);
      tsharkActiveClients--;
      broadcastTsharkStatus();
    }
  }

  parseTextLine(line) {
    // Parse tshark text output line like:
    //   1 0.000000 172.20.0.12 → 172.20.0.1 GSMTAP 83 (CCCH) (RR) System Information Type 4
    const m = line.match(
      /^\s*(\d+)\s+([\d.]+)\s+(\S+)\s+(?:→|->)\s+(\S+)\s+(\S+)\s+(\d+)\s*(.*)/
    );
    if (!m) return null;

    const src = m[3], dst = m[4];

    packetIdGlobal++;
    const info = m[7].trim() || m[5];

    // Drop TRX Clock / jitter noise
    if (info.includes('TRX Clock Ind') || info.includes('clock jitter')) return null;

    return {
      id: packetIdGlobal,
      ts: parseFloat(m[2]),
      src,
      dst,
      protocol: m[5],
      length: parseInt(m[6]),
      info,
    };
  }

  mergePacket(text, ek) {
    let opId = '';
    let direction = '';

    const pkt = {
      id: text.id,
      ts: text.ts,
      src: text.src,
      dst: text.dst,
      protocol: text.protocol,
      length: text.length,
      info: text.info,
      arfcn: '',
      uplink: false,
      channel: '',
      timeslot: '',
      fn: '',
      layers: null,
      hexDump: null,
    };

    let hasGsmtap = false;
    let hasSctp = false;

    if (ek && ek.layers) {
      pkt.layers = ek.layers;

      const gt = ek.layers.gsmtap;
      if (gt) {
        hasGsmtap = true;
        pkt.arfcn    = this.getField(gt, 'gsmtap_gsmtap_arfcn');
        pkt.uplink   = this.getField(gt, 'gsmtap_gsmtap_uplink') === '1';
        pkt.channel  = this.getField(gt, 'gsmtap_gsmtap_chan_type');
        pkt.timeslot = this.getField(gt, 'gsmtap_gsmtap_timeslot');
        pkt.fn       = this.getField(gt, 'gsmtap_gsmtap_frame_nr');
        direction = pkt.uplink ? 'UL' : 'DL';
      }

      // Extract hex dump
      if (ek.layers.frame && ek.layers.frame.frame_frame_raw) {
        const rawArr = ek.layers.frame.frame_frame_raw;
        pkt.hexDump = Array.isArray(rawArr) ? rawArr[0] : rawArr;
      } else {
        for (const [k, v] of Object.entries(ek.layers)) {
          if (k.endsWith('_raw') && typeof v === 'object') {
            const vals = Array.isArray(v) ? v : [v];
            for (const val of vals) {
              if (typeof val === 'string' && val.length > 10) {
                pkt.hexDump = val;
                break;
              }
            }
          }
          if (pkt.hexDump) break;
        }
      }

      if (ek.layers.sctp) {
        hasSctp = true;
        const sctp = ek.layers.sctp;
        const srcPort = this.getField(sctp, 'sctp_sctp_srcport');
        const dstPort = this.getField(sctp, 'sctp_sctp_dstport');
        if (srcPort || dstPort) pkt.sctpPorts = `${srcPort} → ${dstPort}`;
      }
    }

    // Drop packets that are neither GSMTAP nor SCTP (forwarded noise)
    const textProto = (text.protocol || '').toLowerCase();
    const isKnown = hasGsmtap || hasSctp || textProto.includes('gsmtap') || textProto.includes('sctp') || textProto.includes('m3ua');
    if (!isKnown) return null;

    // ARFCN → Operator: base=514, step=2. 514=OP1, 516=OP2, 518=OP3...
    if (pkt.arfcn) {
      const arfcn = parseInt(pkt.arfcn);
      const opNum = Math.floor((arfcn - 514) / 2) + 1;
      if (opNum >= 1 && opNum <= 24) {
        opId = `OP${opNum}`;
      } else {
        opId = `A${arfcn}`;
      }
    }

    if (hasSctp) {
      // SCTP: derive ops from IPs
      const ipToOp = (ip) => {
        const m = ip && ip.match(/^172\.20\.0\.(\d+)$/);
        if (m) { const n = parseInt(m[1]); if (n >= 11) return `OP${n-10}`; }
        return '';
      };
      const sOp = ipToOp(text.src);
      const dOp = ipToOp(text.dst);
      if (sOp && dOp) { opId = `${sOp}/${dOp}`; direction = `${sOp}→${dOp}`; }
      else if (sOp) { opId = sOp; direction = 'UL'; }
      else if (dOp) { opId = dOp; direction = 'DL'; }
    }

    pkt.opLabel = opId || '—';
    pkt.direction = direction || (pkt.uplink ? 'UL' : 'DL');

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
  const clientObj = { ws, vtyMgr, tsharkSession, clientId, audioProc: null };
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
      case 'audio_start':   startAudio(clientObj); break;
      case 'audio_stop':    stopAudio(clientObj); break;
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

// ─── Audio: PCM via WebSocket (low latency) ─────────────────
// Spawns: docker exec -e PULSE_SERVER=... osmo-operator-1 parec --format=s16le --rate=8000 --channels=1 -d gsm_audio.monitor
// Sends raw s16le PCM chunks as binary WebSocket frames → browser Web Audio API

function startAudio(clientObj) {
  if (clientObj.audioProc) return; // already streaming

  const container = `${PREFIX}1`; // op1 has PulseAudio
  log(`Audio start for client ${clientObj.clientId} via ${container}`);

  const proc = spawn('docker', [
    'exec', '-e', `PULSE_SERVER=${PULSE_SRV}`,
    container,
    'parec',
    '--format=s16le',
    '--rate=8000',
    '--channels=1',
    '--latency-msec=20',
    '-d', AUDIO_SINK,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  clientObj.audioProc = proc;

  proc.stdout.on('data', chunk => {
    if (clientObj.ws.readyState === WebSocket.OPEN) {
      clientObj.ws.send(chunk, { binary: true });
    }
  });

  proc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) dbg('parec:', msg);
  });

  proc.on('error', err => {
    log(`Audio parec error: ${err.message}`);
    clientObj.audioProc = null;
    if (clientObj.ws.readyState === WebSocket.OPEN) {
      clientObj.ws.send(JSON.stringify({ type: 'audio_error', data: { msg: err.message } }));
    }
  });

  proc.on('close', code => {
    log(`Audio parec ended (code ${code}) for client ${clientObj.clientId}`);
    clientObj.audioProc = null;
    if (clientObj.ws.readyState === WebSocket.OPEN) {
      clientObj.ws.send(JSON.stringify({ type: 'audio_stopped', data: { code } }));
    }
  });

  if (clientObj.ws.readyState === WebSocket.OPEN) {
    clientObj.ws.send(JSON.stringify({ type: 'audio_started', data: { rate: 8000, channels: 1, format: 's16le' } }));
  }
}

function stopAudio(clientObj) {
  if (clientObj.audioProc) {
    log(`Audio stop for client ${clientObj.clientId}`);
    try { clientObj.audioProc.kill('SIGTERM'); } catch {}
    clientObj.audioProc = null;
  }
}

// ─── Boot ────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  const ops = discoverOperators();
  activeOpIds = ops;
  log(`osmo-egprs-web listening on :${PORT}`);
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
    stopAudio(client);
  }
  wss.close();
  httpServer.close();
  process.exit(0);
});
