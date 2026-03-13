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

const VTY_PORTS = {
  bsc: 4242, msc: 4254, hlr: 4258, mgw: 4243, stp: 4239,
  bts: 4241, ggsn: 4260, sgsn: 4245, pcu: 4240, baseband: 4247,
};

function log(...a)  { console.log(`[${new Date().toISOString()}]`, ...a); }
function dbg(...a)  { if (VERBOSE) console.log('[DBG]', ...a); }

// ─── State ───────────────────────────────────────────────────
let operators = {};
let activeOpIds = [];
let packetIdGlobal = 0;
let tsharkActiveClients = 0; // Nouveau compteur de clients actifs

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

  // BSC → BTS info
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
    
    const bandToArfcn = {
      'GSM450': 259, 'GSM480': 306, 'GSM750': 438,
      'GSM850': 128, 'GSM900': 1, 'DCS1800': 512, 'PCS1900': 512
    };
    
    if (bts.band && bandToArfcn[bts.band]) {
      bts.arfcn_base = bandToArfcn[bts.band];
    }
    
    if ((m = raw.match(/RACH\s+(\w+)/i)))             bts.rach = m[1];
    if ((m = raw.match(/Timing\s+Advance\s+(\d+)/i))) bts.ta = parseInt(m[1], 10);
    
    op.components.bts = bts;
    
    if (VERBOSE) dbg(`BTS info op${id}:`, JSON.stringify(bts));
  } catch (e) { dbg(`Poll BSC op${id}:`, e.message); }

  // MSC → subscribers
  try {
    const raw = await dockerExecVty(container, VTY_PORTS.msc, ['enable', 'show subscriber all']);
    op.mobiles = [];
    
    const lines = raw.split('\n');
    for (const line of lines) {
      const imsiMatch = line.match(/(\d{15})/);
      if (imsiMatch) {
        op.mobiles.push({ 
          imsi: imsiMatch[1],
          raw: line.trim()
        });
      }
    }
  } catch (e) { dbg(`Poll MSC op${id}:`, e.message); }

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

// ─── Interactive VTY Session ─────────────────────────────────
class VtySession {
  constructor(ws, key, container, port, component, opId, ip) {
    this.ws = ws;
    this.key = key;
    this.proc = null;
    this.alive = false;

    const targetIp = ip || '127.0.0.1';
    log(`VTY open: docker exec -i ${container} telnet ${targetIp} ${port}`);

    this.proc = spawn('docker', [
      'exec', '-i', container, 'telnet', targetIp, String(port)
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.alive = true;

    this.proc.stdout.on('data', d => {
      this._send('vty_data', { key, data: d.toString() });
    });

    this.proc.stderr.on('data', d => {
      this._send('vty_data', { key, data: d.toString() });
    });

    this.proc.on('close', code => {
      this.alive = false;
      this._send('vty_data', { key, data: `\r\n--- session closed (code ${code}) ---\r\n` });
      this._send('vty_disconnected', { key });
      log(`VTY closed: ${key} (code ${code})`);
    });

    this.proc.on('error', err => {
      this.alive = false;
      this._send('vty_error', { key, msg: err.message });
    });

    setTimeout(() => {
      if (!this.alive) return;
      this.write('enable');
      setTimeout(() => {
        if (!this.alive) return;
      }, 500);
    }, 1000);

    this._send('vty_connected', { key, opId, component, port });
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

// ─── tshark Capture par Client ───────────────────────────────
class TsharkSession {
  constructor(ws, clientId) {
    this.ws = ws;
    this.clientId = clientId;
    this.proc = null;
    this.running = false;
    this.buffer = '';
  }

  start() {
    if (this.running) return;
    
    log(`Démarrage tshark pour client ${this.clientId}`);
    
    this.proc = spawn('tshark', [
      '-i', 'any', 
      '-f', `udp port ${GSMTAP_UDP}`,
      '-T', 'ek', 
      '-l', 
      '-n',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.running = true;
    this.buffer = '';

    this.proc.stdout.on('data', chunk => {
      this.buffer += chunk.toString();
      let nl;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.substring(0, nl).trim();
        this.buffer = this.buffer.substring(nl + 1);
        if (!line || line.startsWith('{"index"')) continue;
        
        const packet = this.parseLine(line);
        if (packet) {
          this.sendToClient('packet', packet);
        }
      }
    });

    this.proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) this.sendToClient('tshark_log', { msg });
    });

    this.proc.on('close', (code) => {
      log(`tshark client ${this.clientId} arrêté (code ${code})`);
      this.running = false;
      this.sendToClient('tshark_stopped', { code });
      
      // Décrémenter le compteur global
      tsharkActiveClients--;
      broadcastTsharkStatus();
    });

    this.proc.on('error', (err) => {
      log(`tshark client ${this.clientId} erreur:`, err.message);
      this.running = false;
      this.sendToClient('tshark_error', { msg: err.message });
      
      // Décrémenter le compteur global
      tsharkActiveClients--;
      broadcastTsharkStatus();
    });
    
    // Incrémenter le compteur global
    tsharkActiveClients++;
    broadcastTsharkStatus();
  }

  stop() {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
      this.running = false;
      log(`tshark client ${this.clientId} arrêté`);
      
      // Décrémenter le compteur global
      tsharkActiveClients--;
      broadcastTsharkStatus();
    }
  }

  parseLine(line) {
    try {
      const pkt = JSON.parse(line);
      if (!pkt.layers) return null;
      
      packetIdGlobal++;
      const layers = pkt.layers;
      
      const summary = {
        id: packetIdGlobal,
        ts: pkt.timestamp || Date.now() / 1000,
        arfcn:    this.extractField(layers, 'gsmtap', 'gsmtap_gsmtap_arfcn'),
        uplink:   this.extractField(layers, 'gsmtap', 'gsmtap_gsmtap_uplink') === '1',
        channel:  this.extractField(layers, 'gsmtap', 'gsmtap_gsmtap_chan_type'),
        timeslot: this.extractField(layers, 'gsmtap', 'gsmtap_gsmtap_timeslot'),
        fn:       this.extractField(layers, 'gsmtap', 'gsmtap_gsmtap_frame_nr'),
        signal:   this.extractField(layers, 'gsmtap', 'gsmtap_gsmtap_signal_dbm'),
        snr:      this.extractField(layers, 'gsmtap', 'gsmtap_gsmtap_snr_db'),
        frameLen: this.extractField(layers, 'frame', 'frame_frame_len'),
        protocol: '',
        info:     '',
        layers:   layers,
      };
      
      const { protocol, info } = this.identifyProtocol(layers);
      summary.protocol = protocol;
      summary.info = info;
      
      return summary;
    } catch (e) {
      dbg('tshark parse error:', e.message);
      return null;
    }
  }

  extractField(layers, layer, field) {
    if (!layers[layer]) return '';
    const v = layers[layer][field];
    return Array.isArray(v) ? v[0] || '' : v || '';
  }

  identifyProtocol(layers) {
    const protoMap = [
      ['gsm_a.dtap', 'GSM DTAP'], ['gsm_a.ccch', 'GSM CCCH'],
      ['gsm_a.sacch', 'GSM SACCH'], ['gsm_a.rr', 'GSM RR'],
      ['gsm_sms', 'GSM SMS'], ['gsm_a.bssmap', 'BSSMAP'],
      ['gsm_map', 'GSM MAP'], ['lapdm', 'LAPDm'], ['gsmtap', 'GSMTAP'],
    ];
    for (const [key, name] of protoMap) {
      if (layers[key]) return { protocol: name, info: this.extractInfo(layers[key]) };
    }
    return { protocol: 'GSMTAP', info: '' };
  }

  extractInfo(layer) {
    for (const [k, v] of Object.entries(layer)) {
      if (k.includes('msg_type') || k.includes('message_type') || k.includes('dtap_msg')) {
        return Array.isArray(v) ? v[0] : String(v);
      }
    }
    for (const [k, v] of Object.entries(layer)) {
      const s = Array.isArray(v) ? v[0] : v;
      if (typeof s === 'string' && s.length < 80 && !k.endsWith('_raw')) return s;
    }
    return '';
  }

  sendToClient(type, data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data, ts: Date.now() }));
    }
  }
}

// ─── Fonction pour broadcast du statut tshark ────────────────
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
const clients = new Set(); // { ws, vtyMgr, tsharkSession }

wss.on('connection', (ws, req) => {
  log(`Client connected from ${req.socket.remoteAddress}`);
  
  const clientId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  const vtyMgr = new VtySessionManager(ws);
  const tsharkSession = new TsharkSession(ws, clientId);
  
  clients.add({ ws, vtyMgr, tsharkSession, clientId });

  ws.send(JSON.stringify({
    type: 'init',
    data: { 
      operators, 
      activeOpIds, 
      vtyPorts: VTY_PORTS,
      tsharkActive: tsharkActiveClients > 0 
    },
    ts: Date.now(),
  }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    
    switch (msg.type) {
      case 'vty_connect':  
        vtyMgr.connect(msg.opId, msg.component, msg.ip); 
        break;
      case 'vty_exec':     
        vtyMgr.exec(msg.key, msg.cmd); 
        break;
      case 'vty_disconnect': 
        vtyMgr.disconnect(msg.key); 
        break;
      case 'tshark_start': 
        tsharkSession.start(); 
        break;
      case 'tshark_stop':  
        tsharkSession.stop(); 
        break;
      case 'poll':         
        pollAll(); 
        break;
    }
  });

  ws.on('close', () => {
    clients.delete({ ws, vtyMgr, tsharkSession, clientId });
    vtyMgr.closeAll();
    tsharkSession.stop();
    log(`Client ${clientId} disconnected`);
  });
});

// ─── Boot ────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  const ops = discoverOperators();
  activeOpIds = ops;
  log(`osmo-egprs-web listening on :${PORT}`);
  log(`Operators: [${ops.join(', ')}] (${ops.length})`);
  log(`VTY: docker exec -i <container> telnet 127.0.0.1 <port>`);
});

setInterval(pollAll, POLL_MS);
setTimeout(pollAll, 1500);

process.on('SIGINT', () => {
  log('Shutting down');
  
  for (const client of clients) {
    client.tsharkSession.stop();
    client.vtyMgr.closeAll();
  }
  
  wss.close();
  httpServer.close();
  process.exit(0);
});
