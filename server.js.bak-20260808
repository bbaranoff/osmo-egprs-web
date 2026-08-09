'use strict';
const os = require('os');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec, execFile, execFileSync } = require('child_process');

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
const PULSE_SERVER  = process.env.PULSE_SERVER || 'unix:/var/run/pulse/native';
const AUDIO_SOURCE  = process.env.AUDIO_SOURCE || 'gsm_audio.monitor';
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '32k';

const VTY_PORTS = {
  bsc: 4242, msc: 4254, hlr: 4258, mgw: 4243, stp: 4239,
  bts: 4241, ggsn: 4260, sgsn: 4245, pcu: 4240, bb1: 4247, bb2: 4248,
};

const VTY_RETRY_MAX   = 3;
const VTY_RETRY_DELAY = 2000;

// ─── Native (no-docker) mode ─────────────────────────────────
const NATIVE        = (process.env.OSMO_NATIVE !== '0'); // natif par defaut (opt-out OSMO_NATIVE=0)
const OP_IDS        = (process.env.OSMO_OP_IDS || '1').split(',')
                        .map(function(s){ return parseInt(s, 10); })
                        .filter(function(n){ return !isNaN(n); });
const NETNS_PREFIX  = process.env.OSMO_NETNS_PREFIX || '';
function vtyProc(container, port, ip, id) {
  if (NATIVE) {
    if (NETNS_PREFIX) return { bin: 'ip', args: ['netns','exec', NETNS_PREFIX + id, 'telnet', ip, String(port)] };
    return { bin: 'telnet', args: [ip, String(port)] };
  }
  return { bin: 'docker', args: ['exec','-i', container, 'telnet', ip, String(port)] };
}
function shCmd(container, id, inner) {
  if (NATIVE) {
    if (NETNS_PREFIX) return 'ip netns exec ' + NETNS_PREFIX + id + ' bash -c "' + inner + '"';
    return 'bash -c "' + inner + '"';
  }
  return 'docker exec ' + container + ' bash -c "' + inner + '"';
}


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
  if (NATIVE) return Promise.resolve(OP_IDS.slice());
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

    var vc = vtyProc(container, port, targetIp, String(container).replace(PREFIX, ''));
    var proc = spawn(vc.bin, vc.args, { stdio: ['pipe','pipe','pipe'] });

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

  var runningProbe = NATIVE
    ? execAsync(shCmd(container, id, 'ss -tln 2>/dev/null | grep -q :' + VTY_PORTS.bsc + ' && echo true || echo false'), 3000)
    : execAsync('docker inspect -f \'{{.State.Running}}\' ' + container + ' 2>/dev/null', 3000);
  return runningProbe.then(function(running) {
    if (running !== 'true') { op.online = false; operators[id] = op; return; }
    op.online = true;
    op.lastPoll = Date.now();

    return Promise.allSettled([
      // BSC → BTS info
      dockerExecVty(container, VTY_PORTS.bsc, ['enable', 'show bts']).then(function(raw) {
        // 'show bts' liste TOUTES les BTS (hybride : bts0 QEMU + bts1 faketrx).
        var list = [];
        var re = /BTS (\d+) is of ([\w-]+) type in band (\w+), has CI (\d+) LAC (\d+), BSIC (\d+)[^]*?and (\d+) TRX([^]*?)(?=BTS \d+ is of|$)/g;
        var m;
        while ((m = re.exec(raw)) !== null) {
          var arf = m[8].match(/ARFCNs?:\s*(\d+)/);
          list.push({
            nr: parseInt(m[1], 10), type: m[2], band: m[3],
            ci: parseInt(m[4], 10), lac: parseInt(m[5], 10), bsic: parseInt(m[6], 10),
            trx_count: parseInt(m[7], 10), arfcn: arf ? parseInt(arf[1], 10) : undefined,
          });
        }
        op.components.btsList = list;
        op.components.bts = list[0] || {};   // compat
      }).catch(function(e) { dbg('Poll BSC op' + id + ':', e.message); }),

      // MSC → subscribers
      dockerExecVty(container, VTY_PORTS.msc, ['enable', 'show subscriber cache']).then(function(raw) {
        op.mobiles = [];
        raw.split('\n').forEach(function(line) {
          var mm = line.match(/(\d{15})/);
          if (mm) op.mobiles.push({ imsi: mm[1], raw: line.trim() });
        });
      }).catch(function(e) { dbg('Poll MSC op' + id + ':', e.message); }),

      // SMS relay check
      execAsync(
        shCmd(container, id, 'ss -tlnp 2>/dev/null | grep :7890 | wc -l'), 3000
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
  var vc = vtyProc(this.container, this.port, this.ip, this.opId);
  log('VTY open: ' + vc.bin + ' ' + vc.args.join(' ') + ' (attempt ' + (this.retries + 1) + ')');

  this.proc = spawn(vc.bin, vc.args, { stdio: ['pipe','pipe','pipe'] });

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
VtySession.prototype.writeRaw = function(s) {
  if (this.alive && this.proc && this.proc.stdin.writable) this.proc.stdin.write(s);
};
// Complétion VTY osmocom : '?' liste les options. telnet (stdin = pipe) est en
// mode LIGNE → il faut un newline pour flusher. osmocom traite le '?' char-par-char
// (affiche la liste + redessine le partiel) ; le '\r\n' qui suit n'exécute que le
// partiel (souvent incomplet → "% Command incomplete", inoffensif), et la ligne
// VTY est remise à zéro → pas de duplication au prochain Enter du client.
VtySession.prototype.complete = function(partial) {
  this.write((partial || '') + '?');
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
VtySessionManager.prototype.complete = function(key, partial) {
  var s = this.sessions[key];
  if (s && s.alive) s.complete(partial);
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
    else          { this.capIface = 'lo';   log('GW ' + DOCKER_GW_IP + ' non trouvée, fallback "lo"'); }
  }

  var FILTER = 'udp port ' + GSMTAP_UDP + ' or sctp';
  var args = [
    '-i', this.capIface,
  ];
  // -p (no promiscuous) seulement si ce n'est pas "any"
  if (this.capIface !== 'lo') args.push('-p');
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
// Lit le pcap de façon sûre : copie dans un tmp avant de le lire
// pour éviter les conflits avec tshark qui écrit en live.
function safePcapRead(args, cb) {
  if (!fs.existsSync(PCAP_PATH)) { cb(new Error('pcap absent'), ''); return; }
  var tmp = PCAP_PATH + '.snap.' + Date.now();
  exec('cp ' + PCAP_PATH + ' ' + tmp, function(cerr) {
    if (cerr) { cb(cerr, ''); return; }
    // Remplacer -r PCAP_PATH par -r tmp dans les args
    var a = args.map(function(x) { return x === PCAP_PATH ? tmp : x; });
    execFile('tshark', a, { maxBuffer: 4 * 1024 * 1024 }, function(err, stdout, stderr) {
      fs.unlink(tmp, function() {});
      cb(err, stdout || '', stderr || '');
    });
  });
}

TsharkSession.prototype.fetchHex = function(frameNum) {
  var self = this;
  safePcapRead(['-r', PCAP_PATH, '-Y', 'frame.number == ' + frameNum, '-x'],
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

TsharkSession.prototype.fetchDissect = function(frameNum) {
  var self = this;
  if (!fs.existsSync(PCAP_PATH)) {
    log('[DISSECT] pcap absent:', PCAP_PATH);
    self.sendToClient('packet_dissect', { frameNum: frameNum, layers: null });
    return;
  }
  log('[DISSECT] frame ' + frameNum);
  safePcapRead([
    '-r', PCAP_PATH,
    '-Y', 'frame.number == ' + frameNum,
    '-T', 'json',
    '-2',          // two-pass analysis → dissection complète, gsm_sms exposé au premier niveau
    '-d', 'udp.port==' + GSMTAP_UDP + ',gsmtap',
    '-n',
  ], function(err, stdout, stderr) {
    if (stderr && stderr.trim()) dbg('[DISSECT stderr]', stderr.trim());
    if (err || !stdout || !stdout.trim()) {
      log('[DISSECT] erreur:', err && err.message);
      self.sendToClient('packet_dissect', { frameNum: frameNum, layers: null });
      return;
    }
    self._parseDissect(frameNum, stdout);
  });
};

TsharkSession.prototype._parseDissect = function(frameNum, stdout) {
  var self = this;
  try {
    var arr = JSON.parse(stdout);
    if (!arr || !arr.length || !arr[0]._source) {
      self.sendToClient('packet_dissect', { frameNum: frameNum, layers: null });
      return;
    }
    var raw = arr[0]._source.layers;
    log('[DISSECT] frame ' + frameNum + ' keys:', Object.keys(raw).join(', '));

    // Debug: dump gsm_a.rp pour comprendre la structure réelle
    if (raw['gsm_a.rp']) {
      log('[DISSECT] gsm_a.rp keys:', JSON.stringify(Object.keys(raw['gsm_a.rp'])));
      // Chercher les _tree
      Object.keys(raw['gsm_a.rp']).forEach(function(k) {
        if (k.endsWith('_tree') && typeof raw['gsm_a.rp'][k] === 'object') {
          log('[DISSECT] gsm_a.rp.' + k + ' keys:', JSON.stringify(Object.keys(raw['gsm_a.rp'][k])));
        }
      });
    }

    // Approche directe : scanner toutes les clés du JSON à plat
    // et regrouper les champs par préfixe de protocole connu
    var KNOWN_PROTOS = ['gsm_sms', 'rtp', 'rtcp', 'diameter', 'gtpv1', 'gtpv2', 'map', 'isup', 'sccp', 'm3ua'];
    var found = flatScanProtos(raw, KNOWN_PROTOS);
    Object.keys(found).forEach(function(proto) {
      if (!raw[proto]) {
        raw[proto] = found[proto];
        log('[DISSECT] flatScan hoist:', proto, '(' + Object.keys(found[proto]).length + ' champs)');
      }
    });

    log('[DISSECT] final keys:', Object.keys(raw).join(', '));
    var layers = reorderLayers(raw);
    self.sendToClient('packet_dissect', { frameNum: frameNum, layers: layers });
  } catch(e) {
    log('[DISSECT] parse error:', e.message);
    self.sendToClient('packet_dissect', { frameNum: frameNum, layers: null });
  }
};

// Scan récursif à plat : trouve toutes les clés commençant par un proto connu
// et les regroupe dans un objet {proto: {clé: valeur}}
function flatScanProtos(obj, protos) {
  var result = {};
  function scan(o) {
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return;
    Object.keys(o).forEach(function(k) {
      var v = o[k];
      // Vérifier si k correspond à un proto connu (k === proto ou k commence par proto + '.')
      protos.forEach(function(proto) {
        if (k === proto || k.startsWith(proto + '.') || k.startsWith(proto + '_')) {
          if (!result[proto]) result[proto] = {};
          result[proto][k] = v;
        }
      });
      // Récurser
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) scan(v);
    });
  }
  scan(obj);
  return result;
}

// Réordonne : frame en premier, puis ordre de frame.protocols,
// puis sous-protocoles extraits des _tree (gsm_sms, etc.), puis le reste.
function reorderLayers(raw) {
  if (!raw) return raw;
  var frame     = raw['frame'] || {};
  var protosStr = frame['frame.protocols'] || '';
  var protoOrder = protosStr.split(':').filter(function(p) {
    return p && p !== 'ethertype' && p !== 'llc';
  });

  var ordered = {};
  var seen    = {};

  // frame en premier
  if (raw['frame']) { ordered['frame'] = raw['frame']; seen['frame'] = true; }

  // Couches dans l'ordre de frame.protocols
  protoOrder.forEach(function(proto) {
    if (seen[proto] || raw[proto] === undefined) return;
    ordered[proto] = raw[proto];
    seen[proto] = true;
  });

  // Reste des couches de premier niveau (non couvertes par protocols)
  Object.keys(raw).forEach(function(k) {
    if (!seen[k]) { ordered[k] = raw[k]; seen[k] = true; }
  });

  // Hisser les sous-protocoles nichés dans les _tree
  // ex: gsm_a.rp → gsm_a.rp_tree → gsm_sms
  var hoisted = {};
  hoistFromTrees(raw, hoisted, seen);
  Object.keys(hoisted).forEach(function(k) {
    ordered[k] = hoisted[k];
  });

  return ordered;
}

// Parcourt récursivement tous les _tree pour trouver des objets-protocoles
// (objet dont toutes les clés partagent le même préfixe court, ex: "gsm_sms")
function hoistFromTrees(obj, hoisted, seen) {
  if (typeof obj !== 'object' || obj === null) return;
  Object.keys(obj).forEach(function(k) {
    var v = obj[k];
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return;

    if (k.endsWith('_tree')) {
      // Chercher des sous-protocoles directs dans ce _tree
      Object.keys(v).forEach(function(sk) {
        var sv = v[sk];
        if (typeof sv !== 'object' || sv === null || Array.isArray(sv)) return;
        if (sk.endsWith('_raw') || sk.endsWith('_tree')) return;
        // C'est un sous-protocole si ses clés partagent le préfixe sk
        var skPfx = sk.replace(/\./g, '_');
        var subKeys = Object.keys(sv).filter(function(x){ return !x.endsWith('_raw'); });
        if (subKeys.length === 0) return;
        var looksLikeProto = subKeys.every(function(x) {
          return x.startsWith(skPfx) || x.startsWith(sk) || x.endsWith('_tree');
        });
        if (looksLikeProto && !seen[sk]) {
          seen[sk] = true;
          hoisted[sk] = sv;
          log('[HOIST]', sk, '(' + subKeys.length + ' champs)');
        }
      });
      // Récurser dans le _tree
      hoistFromTrees(v, hoisted, seen);
    } else if (!k.endsWith('_raw')) {
      // Récurser dans les sous-objets normaux
      hoistFromTrees(v, hoisted, seen);
    }
  });
}

TsharkSession.prototype.parseLine = function(line) {
  var f = line.split('\t');
  if (f.length < 7) return null;

  var protos  = f[14] || '';
  var isGsmtap = protos.indexOf('gsmtap') >= 0;
  var isGsmSms  = protos.indexOf('gsm_sms') >= 0 ||
                  (protos.indexOf('gsm_a.rp') >= 0 && (f[6]||'').indexOf('(SMS)') >= 0) ||
                  (f[6]||'').indexOf('SMS-DELIVER') >= 0 ||
                  (f[6]||'').indexOf('SMS-SUBMIT') >= 0;
  var isRpData  = protos.indexOf('gsm_a.rp') >= 0;
  var isSctp    = protos.indexOf('sctp') >= 0 || protos.indexOf('m3ua') >= 0;
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

  // Dériver le protocole affiché depuis frame.protocols plutôt que _ws.col.Protocol
  // pour que "sms" dans le filtre UI matche bien les SMS
  var displayProto = f[5] || '';
  if      (isGsmSms)                           displayProto = 'GSM_SMS';
  else if (isRpData && info.indexOf('RP-DATA') >= 0) displayProto = 'GSM_SMS';
  else if (protos.indexOf('gsm_a.dtap') >= 0)  displayProto = 'DTAP';
  else if (protos.indexOf('lapdm') >= 0)       displayProto = 'LAPDm';
  else if (protos.indexOf('gsmtap') >= 0)      displayProto = 'GSMTAP';

  var pkt = {
    id:        ++packetIdGlobal,
    frameNum:  parseInt(f[0])  || 0,
    ts:        parseFloat(f[1]) || 0,
    src: src, dst: dst,
    protocol:  displayProto,
    length:    parseInt(f[4])  || 0,
    info:      info,
    arfcn: '', uplink: false, channel: '', timeslot: '', fn: '',
    layers: null,
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

// ─── Audio bridge : parec gsm_audio.monitor | ffmpeg mp3, flux PARTAGÉ (refcount) ──
// gsm_audio.monitor = monitor du null-sink où gapk écrit TOUT l'audio des appels.
// Un seul parec|ffmpeg pour tous les clients ; lazy-start au 1er GET /audio, kill à 0.
function AudioBridge() { this.parec = null; this.ffmpeg = null; this.running = false; this.clients = new Set(); }
AudioBridge.prototype._start = function() {
  if (this.running) return;
  log('audio bridge start (' + AUDIO_SOURCE + ' @ ' + PULSE_SERVER + ')');
  this.running = true;
  var self = this;
  var env = Object.assign({}, process.env, { PULSE_SERVER: PULSE_SERVER });
  this.parec = spawn('parec', ['-d', AUDIO_SOURCE, '--format=s16le', '--rate=8000', '--channels=1'],
                     { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
  this.ffmpeg = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
                      '-f', 's16le', '-ar', '8000', '-ac', '1', '-i', 'pipe:0',
                      '-c:a', 'libmp3lame', '-b:a', AUDIO_BITRATE, '-ar', '44100', '-ac', '1',
                      '-fflags', '+nobuffer', '-flush_packets', '1', '-f', 'mp3', 'pipe:1'],
                     { stdio: ['pipe', 'pipe', 'pipe'] });
  this.parec.stdout.pipe(this.ffmpeg.stdin);
  this.ffmpeg.stdin.on('error', function(e) { dbg('ffmpeg stdin: ' + e.message); });
  this.parec.stdout.on('error', function(e) { dbg('parec stdout: ' + e.message); });
  this.ffmpeg.stdout.on('data', function(chunk) {
    self.clients.forEach(function(res) { try { res.write(chunk); } catch (e) {} });
  });
  this.parec.stderr.on('data', function(d) { var m = d.toString().trim(); if (m) dbg('parec: ' + m); });
  this.ffmpeg.stderr.on('data', function(d) { var m = d.toString().trim(); if (m) dbg('ffmpeg: ' + m); });
  function onExit(who) { return function(code) {
    log('audio ' + who + ' exit (' + code + ')');
    if (self.running) { self.running = false; self._hardKill();
      if (self.clients.size > 0) setTimeout(function() { if (self.clients.size > 0) self._start(); }, 1000); }
  }; }
  this.parec.on('close', onExit('parec')); this.ffmpeg.on('close', onExit('ffmpeg'));
  this.parec.on('error', function(e) { log('audio parec error: ' + e.message); });
  this.ffmpeg.on('error', function(e) { log('audio ffmpeg error: ' + e.message); });
};
AudioBridge.prototype._hardKill = function() {
  var procs = [this.parec, this.ffmpeg]; this.parec = null; this.ffmpeg = null;
  procs.forEach(function(p) { if (!p) return; try { p.kill('SIGINT'); } catch (e) {}
    setTimeout(function() { try { p.kill('SIGKILL'); } catch (e) {} }, 1000); });
};
AudioBridge.prototype._stop = function() { if (!this.running) return; log('audio bridge stop'); this.running = false; this._hardKill(); };
AudioBridge.prototype.pipeToClient = function(res) {
  var self = this; this.clients.add(res); if (!this.running) this._start();
  function detach() { if (!self.clients.has(res)) return; self.clients.delete(res); if (self.clients.size === 0) self._stop(); }
  res.on('close', detach); res.on('error', detach);
};
var audioBridge = new AudioBridge();

// ─── HTTP Server ─────────────────────────────────────────────
const MIME = {
  '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png',
  '.woff2':'font/woff2', '.woff':'font/woff',
};
const webDir = path.join(__dirname, 'web');

// ─── FFT natif (Welch PSD) ───────────────────────────────────
// Port direct de fft-web/fft_web.py en JS pur : lit les sources I/Q complex64
// (cfile en tail, ou FIFO live O_RDWR|O_NONBLOCK), calcule la PSD Welch
// (fenêtre Hanning, NSEG_MAX segments moyennés), et renvoie le même JSON que
// l'ancien backend Python. Aucune dépendance externe — le dashboard sert les
// deux spectres MS/BTS nativement dans son onglet « 📡 FFT ».
const FFT_RATE     = parseFloat(process.env.RATE || '1083333');   // Fs natif = 26e6/24
const FFT_NSAMP    = parseInt(process.env.NSAMP    || '262144', 10);
const FFT_NFFT     = parseInt(process.env.NFFT     || '4096', 10);   // doit être une puissance de 2
const FFT_NSEG_MAX = parseInt(process.env.NSEG_MAX || '16', 10);
const FFT_MAXB     = FFT_NSAMP * 8;                                  // octets gardés (complex64 = 8 o/échantillon)
const FFT_SRC = {
  ms:  { path: process.env.CFILE_MS  || '/dev/shm/dsp_iq.cfile', arfcn: process.env.ARFCN_MS  || '514', label: 'MS — Calypso DSP (dsp_iq.cfile)' },
  bts: { path: process.env.CFILE_BTS || '/tmp/iq_fft.fifo',      arfcn: process.env.ARFCN_BTS || '514', label: 'BTS — DL relay LIVE (iq_fft.fifo)' },
};
var fftState = {};                                                  // src -> { fd, buf:Buffer }

// Logs adossés à chaque spectre (queue brute, ANSI conservé → colorisé côté web).
// MS  : log du mobile osmocom (sous la FFT DSP).   BTS : log grgsm record (au-dessus de la FFT BTS).
const FFT_LOG = {
  ms:  process.env.FFT_LOG_MS  || '/root/mobile.log',
  bts: process.env.FFT_LOG_BTS || '/root/grgsm_clair.raw',
};
const FFT_LOG_BYTES = parseInt(process.env.FFT_LOG_BYTES || '16384', 10);   // queue lue par requête

// FFT itérative radix-2 (Cooley-Tukey), in-place sur re[]/im[] Float64Array.
function makeFFT(n) {
  var levels = Math.round(Math.log2(n));
  if ((1 << levels) !== n) throw new Error('NFFT doit être une puissance de 2');
  var rev = new Uint32Array(n);
  for (var i = 0; i < n; i++) { var x = i, r = 0; for (var j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  var cos = new Float64Array(n >> 1), sin = new Float64Array(n >> 1);
  for (var k = 0; k < (n >> 1); k++) { var a = -2 * Math.PI * k / n; cos[k] = Math.cos(a); sin[k] = Math.sin(a); }
  return function(re, im) {
    for (var i = 0; i < n; i++) { var r = rev[i]; if (r > i) { var t = re[i]; re[i] = re[r]; re[r] = t; t = im[i]; im[i] = im[r]; im[r] = t; } }
    for (var len = 2; len <= n; len <<= 1) {
      var half = len >> 1, step = (n / len) | 0;
      for (var i2 = 0; i2 < n; i2 += len) {
        for (var k2 = 0, tw = 0; k2 < half; k2++, tw += step) {
          var wr = cos[tw], wi = sin[tw];
          var ar = re[i2 + k2 + half], ai = im[i2 + k2 + half];
          var br = ar * wr - ai * wi, bi = ar * wi + ai * wr;
          re[i2 + k2 + half] = re[i2 + k2] - br; im[i2 + k2 + half] = im[i2 + k2] - bi;
          re[i2 + k2] += br; im[i2 + k2] += bi;
        }
      }
    }
  };
}
const fftRun = makeFFT(FFT_NFFT);
const fftHann = new Float64Array(FFT_NFFT);                         // np.hanning(M) = 0.5 - 0.5 cos(2πn/(M-1))
for (let i = 0; i < FFT_NFFT; i++) fftHann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_NFFT - 1));

function fftIsFifo(p) {
  try { return fs.statSync(p).isFIFO(); } catch (e) { return p.endsWith('.fifo'); }
}

// Vue Float32 alignée (re,im entrelacés) sur les `n` derniers octets d'un Buffer.
function fftAlignedF32(buf, n) {
  var a = new Uint8Array(n);
  a.set(buf.subarray(buf.length - n));
  return new Float32Array(a.buffer, 0, n >> 2);
}

function fftReadLive(src, p) {                                      // FIFO live, jamais d'EOF (O_RDWR), borné à MAXB
  var st = fftState[src];
  if (!st) {
    if (!fs.existsSync(p)) { try { execFileSync('mkfifo', ['-m', '0666', p]); } catch (e) {} }
    var fd = fs.openSync(p, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    st = { fd: fd, buf: Buffer.alloc(0) };
    fftState[src] = st;
  }
  var chunk = Buffer.allocUnsafe(1 << 16);
  var drained = 0;                                                  // borne le drain par appel : sinon une FIFO alimentée
  while (drained < FFT_MAXB) {                                       // en continu ne renvoie jamais EAGAIN -> event loop gele
    var nread;
    try { nread = fs.readSync(st.fd, chunk, 0, chunk.length, null); }
    catch (e) { if (e.code === 'EAGAIN') break; throw e; }
    if (nread <= 0) break;
    drained += nread;
    st.buf = Buffer.concat([st.buf, chunk.subarray(0, nread)]);
    if (st.buf.length > FFT_MAXB) st.buf = Buffer.from(st.buf.subarray(st.buf.length - FFT_MAXB));
  }
  var n = st.buf.length & ~7;                                       // multiple de 8 octets
  if (n < FFT_NFFT * 8) return null;
  return fftAlignedF32(st.buf, n);
}

function fftReadTail(p) {                                           // cfile qui grandit : on lit la queue fraîche
  var sz = fs.statSync(p).size;
  var nbytes = Math.min(sz - (sz % 8), FFT_NSAMP * 8);
  if (nbytes < FFT_NFFT * 8) return null;
  var buf = Buffer.alloc(nbytes);
  var fd = fs.openSync(p, 'r');
  try { fs.readSync(fd, buf, 0, nbytes, sz > nbytes ? sz - nbytes : 0); }
  finally { fs.closeSync(fd); }
  var a = new Uint8Array(nbytes); a.set(buf);
  return new Float32Array(a.buffer, 0, nbytes >> 2);
}

function fftWelch(fl) {                                             // fl: Float32Array [re,im,...] → {freqs,psd} sous-échantillonnés
  var nsamp = fl.length >> 1;
  if (nsamp < FFT_NFFT) return null;
  var nseg = Math.min((nsamp / FFT_NFFT) | 0, FFT_NSEG_MAX);
  var start = nsamp - nseg * FFT_NFFT;                             // garde les segments les plus frais
  var acc = new Float64Array(FFT_NFFT);
  var re = new Float64Array(FFT_NFFT), im = new Float64Array(FFT_NFFT);
  for (var s = 0; s < nseg; s++) {
    var base = (start + s * FFT_NFFT) * 2;
    for (var i = 0; i < FFT_NFFT; i++) { var w = fftHann[i]; re[i] = fl[base + 2 * i] * w; im[i] = fl[base + 2 * i + 1] * w; }
    fftRun(re, im);
    for (var i2 = 0; i2 < FFT_NFFT; i2++) acc[i2] += re[i2] * re[i2] + im[i2] * im[i2];
  }
  var half = FFT_NFFT >> 1;
  var step = Math.max(1, (FFT_NFFT / 1024) | 0);                   // sous-échantillonne pour le transport
  var freqs = [], psd = [];
  for (var k = 0; k < FFT_NFFT; k += step) {
    var srcBin = (k + half) % FFT_NFFT;                            // fftshift
    freqs.push(Math.round((k - half) * FFT_RATE / FFT_NFFT / 1e3 * 10) / 10);   // kHz, 1 décimale
    psd.push(Math.round((10 * Math.log10(acc[srcBin] / nseg + 1e-12)) * 100) / 100);
  }
  return { freqs: freqs, psd: psd };
}

function psdJson(src) {
  if (!FFT_SRC[src]) src = 'ms';
  var s = FFT_SRC[src];
  try {
    var fl = fftIsFifo(s.path) ? fftReadLive(src, s.path) : fftReadTail(s.path);
    var r = fl ? fftWelch(fl) : null;
    if (!r) return { error: "flux pas encore prêt (pas assez d'échantillons)", label: s.label };
    return { label: s.label, arfcn: s.arfcn, rate: FFT_RATE, freqs: r.freqs, psd: r.psd };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { error: 'source absente (' + s.path + ') — lance la stack', label: s.label };
    return { error: String((e && e.message) || e), label: s.label };
  }
}

function logTail(which) {                                           // queue brute du log (ANSI conservé)
  var p = FFT_LOG[which];
  if (!p) return { error: 'log inconnu' };
  try {
    var sz = fs.statSync(p).size;
    var n = Math.min(sz, FFT_LOG_BYTES);
    if (n === 0) return { text: '', path: p };
    var buf = Buffer.alloc(n);
    var fd = fs.openSync(p, 'r');
    try { fs.readSync(fd, buf, 0, n, sz > n ? sz - n : 0); } finally { fs.closeSync(fd); }
    return { text: buf.toString('utf8'), path: p };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { error: 'log absent (' + p + ')', path: p };
    return { error: String((e && e.message) || e), path: p };
  }
}

const httpServer = http.createServer(function(req, res) {
  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ operators: operators, activeOpIds: activeOpIds, tsharkActive: tsharkActiveClients > 0 }));
  }
  if (req.url.split('?')[0] === '/psd') {     // FFT natif (Welch PSD en JS) → onglet FFT du dashboard
    var m = /[?&]src=(ms|bts)/.exec(req.url);
    var body = Buffer.from(JSON.stringify(psdJson(m ? m[1] : 'ms')));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': body.length });
    return res.end(body);
  }
  if (req.url.split('?')[0] === '/logtail') { // queue des logs mobile (MS) / grgsm record (BTS)
    var lm = /[?&]which=(ms|bts)/.exec(req.url);
    var lb = Buffer.from(JSON.stringify(logTail(lm ? lm[1] : 'ms')));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': lb.length });
    return res.end(lb);
  }
  if (req.url.split('?')[0] === '/audio') {   // strip ?query (cache-buster) — sinon 404 statique
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg', 'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache, no-store', 'Connection': 'keep-alive',
    });
    audioBridge.pipeToClient(res);
    return;
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
      case 'vty_complete':           vtyMgr.complete(msg.key, msg.partial);          break;
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
  try { audioBridge._stop(); } catch (e) {}
  clients.forEach(function(c) { c.tsharkSession.stop(); c.vtyMgr.closeAll(); });
  wss.close();
  httpServer.close();
  process.exit(0);
});
