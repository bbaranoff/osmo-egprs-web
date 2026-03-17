'use strict';
const os = require('os');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec, execFile } = require('child_process');

function execAsync(cmd, timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  return new Promise(function(resolve, reject) {
    exec(cmd, { timeout: timeoutMs, encoding: 'utf-8' }, function(err, stdout) {
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
const VERBOSE    = process.argv.indexOf('--verbose') >= 0;
const PCAP_PATH  = process.env.PCAP_PATH || '/tmp/capture.pcap';

const VTY_PORTS = {
  bsc: 4242, msc: 4254, hlr: 4258, mgw: 4243, stp: 4239,
  bts: 4241, ggsn: 4260, sgsn: 4245, pcu: 4240, baseband: 4247,
};

const VTY_RETRY_MAX   = 3;
const VTY_RETRY_DELAY = 2000;

function log()  { var a = Array.prototype.slice.call(arguments); console.log.apply(console, ['[' + new Date().toISOString() + ']'].concat(a)); }
function dbg()  { if (VERBOSE) { var a = Array.prototype.slice.call(arguments); console.log.apply(console, ['[DBG]'].concat(a)); } }

// ─── GSMTAP Channel Type Map ─────────────────────────────────
const GSMTAP_CHAN = {
  '0':'UNKNOWN','1':'BCCH','2':'CCCH','3':'SDCCH4','4':'SDCCH8',
  '5':'BCCH','6':'SDCCH','7':'TCH/F','8':'TCH/H','9':'PACCH',
  '10':'CBCH52','11':'PDCH','12':'PTCCH','13':'CBCH51','128':'ACCH',
};

// ─── State ───────────────────────────────────────────────────
var operators         = {};
var activeOpIds       = [];
var packetIdGlobal    = 0;
var tsharkActiveClients = 0;
var clients           = new Set();

// ─── Docker Discovery ────────────────────────────────────────
function discoverOperators() {
  return execAsync(
    'docker ps --filter "name=' + PREFIX + '" --format "{{.Names}}"', 5000
  ).then(function(raw) {
    if (!raw) return [];
    var seen = {};
    var ids = [];
    raw.split('\n').forEach(function(n) {
      var m = n.match(new RegExp(PREFIX + '(\\d+)'));
      if (m) {
        var id = parseInt(m[1]);
        if (!seen[id]) { seen[id] = true; ids.push(id); }
      }
    });
    return ids.sort(function(a,b){ return a-b; });
  }).catch(function() { return activeOpIds; });
}

// ─── VTY via docker exec telnet ──────────────────────────────
function dockerExecVty(container, port, commands, ip) {
  var targetIp = ip || '127.0.0.1';
  return new Promise(function(resolve, reject) {
    var output = '';
    var done = false;
    var timeout = setTimeout(function(){ finish(); }, 8000);

    var proc = spawn('docker', [
      'exec', '-i', container, 'telnet', targetIp, String(port)
    ], { stdio: ['pipe','pipe','pipe'] });

    proc.stdout.on('data', function(d) { output += d.toString(); });
    proc.stderr.on('data', function(d) { output += d.toString(); });
    proc.on('error', function(err) { clearTimeout(timeout); reject(err); });
    proc.on('close', function() { finish(); });

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(output);
    }

    setTimeout(function() {
      commands.forEach(function(cmd) { proc.stdin.write(cmd + '\r\n'); });
      setTimeout(function() {
        proc.stdin.write('exit\r\n');
        proc.stdin.end();
      }, commands.length * 300 + 500);
    }, 600);
  });
}

// ─── VTY Polling ─────────────────────────────────────────────
function pollOperator(id) {
  var container = PREFIX + id;
  var op = operators[id] || { id: id, online: false, components: {}, mobiles: [] };

  return execAsync(
    'docker inspect -f \'{{.State.Running}}\' ' + container + ' 2>/dev/null', 3000
  ).then(function(running) {
    if (running !== 'true') { op.online = false; operators[id] = op; return; }
    op.online = true;
    op.lastPoll = Date.now();

    return Promise.allSettled([
      // BSC → BTS info
      dockerExecVty(container, VTY_PORTS.bsc, ['enable', 'show bts 0']).then(function(raw) {
        var bts = {};
        var m;
        if ((m = raw.match(/CI\s+(\d+)/i)))       bts.ci        = parseInt(m[1], 10);
        if ((m = raw.match(/LAC\s+(\d+)/i)))       bts.lac       = parseInt(m[1], 10);
        if ((m = raw.match(/BSIC\s+(\d+)/i)))      bts.bsic      = parseInt(m[1], 10);
        if ((m = raw.match(/band\s+(\w+)/i)))      bts.band      = m[1];
        if ((m = raw.match(/type\s+([\w-]+)/i)))   bts.type      = m[1];
        if ((m = raw.match(/(\d+)\s+TRX/i)))       bts.trx_count = parseInt(m[1], 10);
        if ((m = raw.match(/ARFCN\s+(\d+)/i)))     bts.arfcn     = parseInt(m[1], 10);
        op.components.bts = bts;
      }).catch(function(e) { dbg('Poll BSC op' + id + ':', e.message); }),

      // MSC → subscribers
      dockerExecVty(container, VTY_PORTS.msc, ['enable', 'show subscriber all']).then(function(raw) {
        op.mobiles = [];
        raw.split('\n').forEach(function(line) {
          var mm = line.match(/(\d{15})/);
          if (mm) op.mobiles.push({ imsi: mm[1], raw: line.trim() });
        });
      }).catch(function(e) { dbg('Poll MSC op' + id + ':', e.message); }),

      // SMS relay check
      execAsync(
        'docker exec ' + container + ' bash -c "ss -tlnp 2>/dev/null | grep :7890 | wc -l"', 3000
      ).then(function(raw) {
        op.smsRelayUp = parseInt(raw) > 0;
      }).catch(function() { op.smsRelayUp = false; }),
    ]);
  }).catch(function() {
    op.online = false;
  }).then(function() {
    operators[id] = op;
  });
}

var pollLock = false;
function pollAll() {
  if (pollLock) { dbg('pollAll skipped'); return; }
  pollLock = true;
  discoverOperators().then(function(ids) {
    activeOpIds = ids;
    Object.keys(operators).map(Number).forEach(function(id) {
      if (ids.indexOf(id) < 0) delete operators[id];
    });
    return Promise.allSettled(ids.map(function(id) { return pollOperator(id); }));
  }).then(function() {
    var stateMsg = JSON.stringify({
      type: 'state',
      data: { operators: operators, activeOpIds: activeOpIds },
      ts: Date.now()
    });
    clients.forEach(function(c) {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(stateMsg);
    });
  }).catch(function(e) { dbg('pollAll error:', e.message); })
    .then(function() { pollLock = false; });
}

// ─── Interactive VTY Session ──────────────────────────────────
function VtySession(ws, key, container, port, component, opId, ip) {
  this.ws        = ws;
  this.key       = key;
  this.container = container;
  this.port      = port;
  this.component = component;
  this.opId      = opId;
  this.ip        = ip || '127.0.0.1';
  this.proc      = null;
  this.alive     = false;
  this.retries   = 0;
  this._connect();
}
VtySession.prototype._connect = function() {
  var self = this;
  log('VTY open: docker exec -i ' + this.container + ' telnet ' + this.ip + ' ' + this.port + ' (attempt ' + (this.retries + 1) + ')');

  this.proc = spawn('docker', [
    'exec', '-i', this.container, 'telnet', this.ip, String(this.port)
  ], { stdio: ['pipe','pipe','pipe'] });

  this.alive = true;
  var gotData = false;

  this.proc.stdout.on('data', function(d) {
    gotData = true;
    self._send('vty_data', { key: self.key, data: d.toString() });
  });
  this.proc.stderr.on('data', function(d) {
    var str = d.toString();
    if (str.indexOf('Connection refused') >= 0 || str.indexOf('Unable to connect') >= 0) {
      self.alive = false;
      if (self.retries < VTY_RETRY_MAX) {
        self.retries++;
        self._send('vty_data', { key: self.key, data: '\r\n--- connection refused, retry ' + self.retries + '/' + VTY_RETRY_MAX + ' ---\r\n' });
        setTimeout(function() { self._connect(); }, VTY_RETRY_DELAY);
        return;
      }
    }
    self._send('vty_data', { key: self.key, data: str });
  });
  this.proc.on('close', function(code) {
    if (!gotData && self.retries < VTY_RETRY_MAX) {
      self.retries++;
      self._send('vty_data', { key: self.key, data: '\r\n--- session closed (code ' + code + '), retry ' + self.retries + '/' + VTY_RETRY_MAX + ' ---\r\n' });
      setTimeout(function() { self._connect(); }, VTY_RETRY_DELAY);
      return;
    }
    self.alive = false;
    self._send('vty_data', { key: self.key, data: '\r\n--- session closed (code ' + code + ') ---\r\n' });
    self._send('vty_disconnected', { key: self.key });
  });
  this.proc.on('error', function(err) {
    self.alive = false;
    self._send('vty_error', { key: self.key, msg: err.message });
  });

  setTimeout(function() { if (self.alive) self.write('enable'); }, 1000);
  this._send('vty_connected', { key: this.key, opId: this.opId, component: this.component, port: this.port, retry: this.retries });
};
VtySession.prototype.write = function(cmd) {
  if (this.alive && this.proc && this.proc.stdin.writable)
    this.proc.stdin.write(cmd + '\r\n');
};
VtySession.prototype.close = function() {
  if (this.proc) {
    try { this.proc.stdin.write('exit\r\n'); } catch(e) {}
    var p = this.proc;
    setTimeout(function() { try { p.kill('SIGTERM'); } catch(e) {} }, 500);
    this.alive = false;
  }
};
VtySession.prototype._send = function(type, data) {
  if (this.ws.readyState === WebSocket.OPEN)
    this.ws.send(JSON.stringify({ type: type, data: data, ts: Date.now() }));
};

function VtySessionManager(ws) {
  this.ws       = ws;
  this.sessions = {};
}
VtySessionManager.prototype.connect = function(opId, component, ip) {
  var key = opId + '-' + component;
  if (this.sessions[key]) { this.sessions[key].close(); delete this.sessions[key]; }
  var port = VTY_PORTS[component];
  if (!port) { this._send('vty_error', { key: key, msg: 'Unknown component: ' + component }); return; }
  this.sessions[key] = new VtySession(this.ws, key, PREFIX + opId, port, component, opId, ip);
};
VtySessionManager.prototype.exec = function(key, cmd) {
  var s = this.sessions[key];
  if (!s || !s.alive) { this._send('vty_error', { key: key, msg: 'Session not connected' }); return; }
  s.write(cmd);
};
VtySessionManager.prototype.disconnect = function(key) {
  var s = this.sessions[key];
  if (s) { s.close(); delete this.sessions[key]; }
  this._send('vty_disconnected', { key: key });
};
VtySessionManager.prototype.closeAll = function() {
  var self = this;
  Object.keys(this.sessions).forEach(function(k) { self.sessions[k].close(); });
  this.sessions = {};
};
VtySessionManager.prototype._send = function(type, data) {
  if (this.ws.readyState === WebSocket.OPEN)
    this.ws.send(JSON.stringify({ type: type, data: data, ts: Date.now() }));
};

// ─── tshark Capture ──────────────────────────────────────────
// -T fields : stream live léger
// -w PCAP_PATH : pcap simultané pour dissection/hex on-demand
function TsharkSession(ws, clientId) {
  this.ws       = ws;
  this.clientId = clientId;
  this.proc     = null;
  this.running  = false;
  this.buf      = '';
  this.capIface = null;
  this.dedupSet = {};
}
TsharkSession.prototype.start = function() {
  if (this.running) return;
  log('tshark start for client ' + this.clientId);

  var DOCKER_GW_IP  = process.env.DOCKER_GW_IP || '172.20.0.1';
  var ENV_CAP_IFACE = process.env.CAP_IFACE || '';

  function findIfaceByIp(ip) {
    var nets = os.networkInterfaces();
    var found = null;
    Object.keys(nets).forEach(function(iface) {
      (nets[iface] || []).forEach(function(addr) {
        if (addr.family === 'IPv4' && addr.address === ip) found = iface;
      });
    });
    return found;
  }

  if (ENV_CAP_IFACE) {
    this.capIface = ENV_CAP_IFACE;
    log('CAP_IFACE forcé: ' + ENV_CAP_IFACE);
  } else {
    var gwIface = findIfaceByIp(DOCKER_GW_IP);
    if (gwIface) { this.capIface = gwIface; log('Interface auto depuis GW ' + DOCKER_GW_IP + ': ' + gwIface); }
    else          { this.capIface = 'any';   log('GW ' + DOCKER_GW_IP + ' non trouvée, fallback "any"'); }
  }

  var FILTER = 'udp port ' + GSMTAP_UDP + ' or sctp';
  var args = [
    '-i', this.capIface,
  ];
  // -p (no promiscuous) seulement si ce n'est pas "any"
  if (this.capIface !== 'any') args.push('-p');
  args = args.concat([
    '-f', FILTER,
    '-d', 'udp.port==' + GSMTAP_UDP + ',gsmtap',
    // Écriture pcap simultanée pour dissection on-demand
    '-w', PCAP_PATH, '-P',
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
  ]);

  log('tshark args: ' + args.join(' '));
  this.proc    = spawn('tshark', args, { stdio: ['ignore','pipe','pipe'] });
  this.running = true;
  this.buf     = '';
  this.dedupSet = {};

  var self = this;

  this.proc.stdout.on('data', function(chunk) {
    self.buf += chunk.toString();
    var nl;
    while ((nl = self.buf.indexOf('\n')) !== -1) {
      var line = self.buf.substring(0, nl);
      self.buf = self.buf.substring(nl + 1);
      if (!line.trim()) continue;
      var pkt = self.parseLine(line);
      if (pkt) self.sendToClient('packet', pkt);
    }
  });
  this.proc.stderr.on('data', function(d) {
    var msg = d.toString().trim();
    if (msg) log('tshark stderr [' + self.clientId + ']: ' + msg);
  });
  this.proc.on('close', function(code) {
    log('tshark [' + self.clientId + '] stopped (code ' + code + ')');
    if (self.running) { self.running = false; tsharkActiveClients--; broadcastTsharkStatus(); }
    self.sendToClient('tshark_stopped', { code: code });
  });
  this.proc.on('error', function(err) {
    log('tshark [' + self.clientId + '] error: ' + err.message);
    if (self.running) { self.running = false; tsharkActiveClients--; broadcastTsharkStatus(); }
    self.sendToClient('tshark_error', { msg: err.message });
  });

  tsharkActiveClients++;
  broadcastTsharkStatus();
};

TsharkSession.prototype.stop = function() {
  if (this.proc) {
    try { this.proc.kill('SIGINT'); } catch(e) {}
    var p = this.proc;
    setTimeout(function() { try { p.kill('SIGTERM'); } catch(e) {} }, 500);
    this.proc = null;
  }
  if (this.running) {
    this.running = false;
    if (tsharkActiveClients > 0) tsharkActiveClients--;
    broadcastTsharkStatus();
  }
};

// Hex dump on-demand depuis le pcap
TsharkSession.prototype.fetchHex = function(frameNum) {
  var self = this;
  if (!fs.existsSync(PCAP_PATH)) {
    self.sendToClient('packet_hex', { frameNum: frameNum, hex: '' });
    return;
  }
  execFile('tshark', ['-r', PCAP_PATH, '-Y', 'frame.number == ' + frameNum, '-x'],
    function(err, stdout) {
      var hex = '';
      if (!err && stdout) {
        stdout.split('\n').forEach(function(line) {
          var m = line.match(/^\s*[0-9a-f]{4}\s+((?:[0-9a-f]{2}\s+)+)/i);
          if (m) hex += m[1].replace(/\s+/g, '');
        });
      }
      self.sendToClient('packet_hex', { frameNum: frameNum, hex: hex });
    }
  );
};

// Dissection complète on-demand depuis le pcap (-T json)
TsharkSession.prototype.fetchDissect = function(frameNum) {
  var self = this;
  if (!fs.existsSync(PCAP_PATH)) {
    self.sendToClient('packet_dissect', { frameNum: frameNum, layers: null });
    return;
  }
  execFile('tshark', [
    '-r', PCAP_PATH,
    '-Y', 'frame.number == ' + frameNum,
    '-T', 'json',
    '-d', 'udp.port==' + GSMTAP_UDP + ',gsmtap',
    '-n',
  ], function(err, stdout) {
    if (err || !stdout) {
      self.sendToClient('packet_dissect', { frameNum: frameNum, layers: null });
      return;
    }
    try {
      var arr = JSON.parse(stdout);
      var layers = (arr && arr[0] && arr[0]._source && arr[0]._source.layers) ? arr[0]._source.layers : null;
      self.sendToClient('packet_dissect', { frameNum: frameNum, layers: layers });
    } catch(e) {
      self.sendToClient('packet_dissect', { frameNum: frameNum, layers: null });
    }
  });
};

TsharkSession.prototype.parseLine = function(line) {
  var f = line.split('\t');
  if (f.length < 7) return null;

  var protos  = f[14] || '';
  var isGsmtap = protos.indexOf('gsmtap') >= 0;
  var isSctp   = protos.indexOf('sctp') >= 0 || protos.indexOf('m3ua') >= 0;
  if (!isGsmtap && !isSctp) return null;

  var info = (f[6] || '').trim();
  var BLACKLIST = ['TRX Clock Ind', 'clock jitter', 'GSM clock', 'elapsed_fn'];
  for (var i = 0; i < BLACKLIST.length; i++) { if (info.indexOf(BLACKLIST[i]) >= 0) return null; }

  // Dedup (même paquet sur veth + bridge)
  var now    = Date.now();
  var tsMs   = Math.round(parseFloat(f[1]) * 1000);
  var dkey   = f[2] + '|' + f[3] + '|' + f[4] + '|' + Math.round(tsMs / 100);
  var dset   = this.dedupSet;
  Object.keys(dset).forEach(function(k) { if (now > dset[k]) delete dset[k]; });
  if (dset[dkey]) return null;
  dset[dkey] = now + 300;

  var src = f[2] || '';
  var dst = f[3] || '';
  var pkt = {
    id:        ++packetIdGlobal,
    frameNum:  parseInt(f[0])  || 0,
    ts:        parseFloat(f[1]) || 0,
    src: src, dst: dst,
    protocol:  f[5] || '',
    length:    parseInt(f[4])  || 0,
    info:      info,
    arfcn: '', uplink: false, channel: '', timeslot: '', fn: '',
    layers: null,   // chargé on-demand via packet_dissect_request
    opLabel: '—', direction: '',
  };

  if (isGsmtap) {
    pkt.arfcn    = f[7]  || '';
    pkt.uplink   = f[8]  === '1';
    pkt.channel  = GSMTAP_CHAN[f[9]] || f[9] || '';
    pkt.timeslot = f[10] || '';
    pkt.fn       = f[11] || '';
    pkt.direction = pkt.uplink ? 'UL' : 'DL';
    var arfcn = parseInt(pkt.arfcn);
    var opNum = Math.floor((arfcn - 514) / 2) + 1;
    pkt.opLabel = (opNum >= 1 && opNum <= 24) ? 'OP' + opNum : 'A' + arfcn;
  } else if (isSctp) {
    pkt.sctpPorts = (f[12] || '') + ' → ' + (f[13] || '');
    function ipToOp(ip) {
      var mm = ip && ip.match(/^172\.20\.0\.(\d+)$/);
      if (mm) { var n = parseInt(mm[1]); if (n >= 11) return 'OP' + (n - 10); }
      // Loopback convention 127.0.<opId>.x
      var ml = ip && ip.match(/^127\.0\.(\d+)\.\d+$/);
      if (ml && parseInt(ml[1]) > 0) return 'OP' + ml[1];
      return '';
    }
    var sOp = ipToOp(src), dOp = ipToOp(dst);
    if (sOp && dOp)      { pkt.opLabel = sOp + '/' + dOp; pkt.direction = sOp + '→' + dOp; }
    else if (sOp)        { pkt.opLabel = sOp; pkt.direction = 'UL'; }
    else if (dOp)        { pkt.opLabel = dOp; pkt.direction = 'DL'; }
  }

  return pkt;
};

TsharkSession.prototype.sendToClient = function(type, data) {
  if (this.ws.readyState === WebSocket.OPEN)
    this.ws.send(JSON.stringify({ type: type, data: data, ts: Date.now() }));
};

function broadcastTsharkStatus() {
  var msg = JSON.stringify({
    type: 'tshark_status',
    data: { active: tsharkActiveClients > 0, clientCount: tsharkActiveClients },
    ts: Date.now()
  });
  clients.forEach(function(c) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  });
}

// ─── HTTP Server ─────────────────────────────────────────────
const MIME = {
  '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png',
  '.woff2':'font/woff2', '.woff':'font/woff',
};
const webDir = path.join(__dirname, 'web');

const httpServer = http.createServer(function(req, res) {
  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ operators: operators, activeOpIds: activeOpIds, tsharkActive: tsharkActiveClients > 0 }));
  }
  var fp = req.url === '/' ? '/index.html' : req.url;
  fp = path.join(webDir, fp);
  var ct = MIME[path.extname(fp)] || 'application/octet-stream';
  fs.readFile(fp, function(err, data) {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
});

// ─── WebSocket Server ────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', function(ws, req) {
  log('Client connected from ' + req.socket.remoteAddress);
  var clientId      = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  var vtyMgr        = new VtySessionManager(ws);
  var tsharkSession = new TsharkSession(ws, clientId);
  var clientObj     = { ws: ws, vtyMgr: vtyMgr, tsharkSession: tsharkSession, clientId: clientId };
  clients.add(clientObj);

  ws.send(JSON.stringify({
    type: 'init',
    data: { operators: operators, activeOpIds: activeOpIds, vtyPorts: VTY_PORTS, tsharkActive: tsharkActiveClients > 0 },
    ts: Date.now(),
  }));

  ws.on('message', function(raw) {
    var msg; try { msg = JSON.parse(raw); } catch(e) { return; }
    switch (msg.type) {
      case 'vty_connect':            vtyMgr.connect(msg.opId, msg.component, msg.ip); break;
      case 'vty_exec':               vtyMgr.exec(msg.key, msg.cmd);                   break;
      case 'vty_disconnect':         vtyMgr.disconnect(msg.key);                      break;
      case 'tshark_start':           tsharkSession.start();                           break;
      case 'tshark_stop':            tsharkSession.stop();                            break;
      case 'packet_hex_request':     tsharkSession.fetchHex(msg.frameNum);            break;
      case 'packet_dissect_request': tsharkSession.fetchDissect(msg.frameNum);        break;
      case 'poll':                   pollAll();                                        break;
    }
  });

  ws.on('close', function() {
    clients.delete(clientObj);
    vtyMgr.closeAll();
    tsharkSession.stop();
    log('Client ' + clientId + ' disconnected');
  });
});

// ─── Boot ────────────────────────────────────────────────────
httpServer.listen(PORT, function() {
  discoverOperators().then(function(ops) {
    activeOpIds = ops;
    log('osmo-egprs-web listening on :' + PORT);
    log('Operators: [' + ops.join(', ') + '] (' + ops.length + ')');
    log('Capture filter: udp port ' + GSMTAP_UDP + ' or sctp');
    log('PCAP: ' + PCAP_PATH);
  });
});

setInterval(pollAll, POLL_MS);
setTimeout(pollAll, 1500);

process.on('SIGINT', function() {
  log('Shutting down');
  clients.forEach(function(c) { c.tsharkSession.stop(); c.vtyMgr.closeAll(); });
  wss.close();
  httpServer.close();
  process.exit(0);
});
