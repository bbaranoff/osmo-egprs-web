'use strict';
const os = require('os');
const http = require('http');
const https = require('https');
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

// ─── Types de message Call Control (GSM 04.08 §10.4) ─────────
// Repli en hex si inconnu : mieux vaut « CC 0x2b » qu'une case vide, qui ne
// distingue pas « type absent » de « type non reconnu ».
const CC_MSG = {
  1:'ALERTING', 2:'CALL PROCEEDING', 3:'PROGRESS', 4:'CC-ESTABLISHMENT',
  5:'SETUP', 6:'CC-EST CONFIRMED', 7:'CONNECT', 8:'CALL CONFIRMED',
  9:'START CC', 11:'RECALL', 14:'EMERGENCY SETUP', 15:'CONNECT ACK',
  16:'USER INFORMATION', 23:'MODIFY REJECT', 24:'MODIFY', 31:'MODIFY COMPLETE',
  37:'DISCONNECT', 42:'RELEASE COMPLETE', 45:'RELEASE', 49:'STOP DTMF',
  50:'STOP DTMF ACK', 52:'STATUS ENQUIRY', 53:'START DTMF', 54:'START DTMF ACK',
  55:'START DTMF REJECT', 58:'CONGESTION CONTROL', 61:'NOTIFY', 62:'STATUS',
  25:'HOLD', 26:'HOLD ACK', 27:'HOLD REJECT',
  28:'RETRIEVE', 29:'RETRIEVE ACK', 30:'RETRIEVE REJECT',
};
// Type de trame LAPDm : I / S / U, puis le sous-type quand il existe.
const LAPDM_S = { 0:'RR', 1:'RNR', 2:'REJ' };
const LAPDM_U = { 0:'UI', 3:'DM', 7:'SABM', 8:'DISC', 12:'UA' };

// ─── Types de message RR utiles (GSM 04.08) ──────────────────
// Valeurs relevees sur le pcap du 12/08. On ne mappe QUE ce qui merite d'etre
// distingue a l'oeil dans un tableau qui defile ; le reste garde son hexa.
const RR_MSG = {
  0x0d:'CHANNEL RELEASE', 0x21:'PAGING REQ 1', 0x29:'ASSIGNMENT COMPLETE',
  0x2e:'ASSIGNMENT CMD',  0x2f:'ASSIGNMENT FAIL', 0x3f:'IMM ASS',
  0x39:'IMM ASS EXT',     0x3a:'IMM ASS REJECT',  0x15:'MEAS REPORT',
  0x06:'SYS INFO 5ter',   0x1d:'SI5', 0x1e:'SI6',
};

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
    // [2026-08-12] LAPDm + CC. Les trames etaient DEJA capturees (mesure :
    // 70 LAPDm et 29 DTAP dans /tmp/capture.pcap) et deja etiquetees LAPDm/DTAP
    // par displayProto — mais sans aucun detail : impossible de distinguer une
    // SABM d'un RR, ni un CC Setup d'un CC Disconnect, autrement qu'en lisant
    // la colonne Info a l'oeil.
    // ⚠️ CES CHAMPS SONT APPENDUS A LA FIN, jamais inseres : parseLine() indexe
    // f[0..14] en dur. Toute insertion au milieu decalerait tout en silence.
    '-e', 'lapdm.sapi',                 // f[15]
    '-e', 'lapdm.cr',                   // f[16]
    '-e', 'lapdm.control.ftype',        // f[17]
    '-e', 'lapdm.control.s_ftype',      // f[18]
    '-e', 'lapdm.control.u_modifier_cmd', // f[19]
    '-e', 'lapdm.control.n_r',          // f[20]
    '-e', 'lapdm.control.n_s',          // f[21]
    '-e', 'gsm_a.dtap.msg_cc_type',     // f[22]
    '-e', 'gsm_a.dtap.msg_mm_type',     // f[23]
    '-e', 'gsm_a.dtap.msg_rr_type',     // f[24]
    '-e', 'gsm_a.dtap.msg_sms_type',    // f[25]
    // IMMEDIATE ASSIGNMENT : porte par gsm_a.ccch mais type dans msg_rr_type
    // (0x3f). Ce qu'on veut lire dessus, c'est le slot assigne et le TA ORDONNE
    // — c'est la premiere valeur de TA de tout l'appel, et la boucle TA de la
    // BTS part de la.
    '-e', 'gsm_a.rr.timeslot',          // f[26]
    '-e', 'gsm_a.rr.timing_adv',        // f[27]
    '-e', 'gsm_a.rr.ra',                // f[28]
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
    l2: '', cc: '', rr: '', l3: '',
  };

  // ── Detail LAPDm / CC (2026-08-12) ──────────────────────────────────────
  // f[15..25], appendus en fin de liste tshark. Champs absents = chaine vide :
  // on ne fabrique rien, une case vide veut dire « pas cette couche ».
  var sapi = f[15], ftype = f[17], sftype = f[18], umod = f[19];
  if (sapi !== undefined && sapi !== '') {
    var t = '';
    // ⚠️ tshark rend ces champs en HEXA (« 0x03 »), pas en decimal — verifie sur
    // le pcap. `parseInt` gere le prefixe 0x, mais une comparaison de CHAINE a
    // '2' ne matche jamais : c'est le piege corrige ici.
    // Format du champ de controle LAPDm (GSM 04.06) : I=0x00, S=0x01, U=0x03.
    var nf = parseInt(ftype);
    if      (nf === 3 && umod   !== '' && umod   !== undefined) t = LAPDM_U[parseInt(umod)]   || ('U 0x' + parseInt(umod).toString(16));
    else if (nf === 1 && sftype !== '' && sftype !== undefined) t = LAPDM_S[parseInt(sftype)] || ('S 0x' + parseInt(sftype).toString(16));
    else if (nf === 0) {
      t = 'I';
      if (f[21] !== '' && f[21] !== undefined) t += ' N(S)=' + f[21];
      if (f[20] !== '' && f[20] !== undefined) t += ' N(R)=' + f[20];
    }
    pkt.l2 = 'SAPI' + sapi + (t ? ' ' + t : '');
  }
  if (f[22] !== undefined && f[22] !== '') {
    var n = parseInt(f[22]);
    pkt.cc = CC_MSG[n] || ('CC 0x' + n.toString(16));
    pkt.l3 = 'CC';
  } else if (f[23] !== undefined && f[23] !== '') { pkt.l3 = 'MM'; }
  else if (f[25] !== undefined && f[25] !== '') { pkt.l3 = 'SMS'; }
  if (f[24] !== undefined && f[24] !== '') {
    var r = parseInt(f[24]);
    if (!pkt.l3) pkt.l3 = 'RR';
    pkt.rr = RR_MSG[r] || ('RR 0x' + r.toString(16));
    // IMM ASS / ASSIGNMENT CMD : on colle le slot et le TA a cote du nom. Sans
    // eux la ligne dit « une assignation a eu lieu » et rien d'exploitable.
    var det = [];
    if (f[26] !== undefined && f[26] !== '') det.push('TS' + parseInt(f[26]));
    if (f[27] !== undefined && f[27] !== '') det.push('TA' + parseInt(f[27]));
    if (f[28] !== undefined && f[28] !== '') det.push('RA' + parseInt(f[28]));
    if (det.length) pkt.rr += ' ' + det.join(' ');
  }

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

// ─── Mic bridge : navigateur → pacat → sink gsm_mic (ce que les mobiles captent) ──
// Le conteneur n'a pas de capture reelle ; sans ce pont, gsm_in ne voit que du
// silence (cf. /etc/asound.conf : gsm_in -> gsm_mic.monitor, pose pour ouvrir la
// boucle audio). Le navigateur envoie du PCM s16le 8 kHz mono en trames
// WebSocket BINAIRES ; on le rejoue tel quel dans gsm_mic.
//
// TROIS PANNES VECUES, TROIS CONTRE-MESURES ICI. Elles ont toutes en commun de
// ne RIEN afficher a l'utilisateur, qui voit « Micro ON » et n'a aucune voix.
//
//  (1) LE DEBIT NE PROUVE RIEN. Le 2026-08-12, ce pont a transporte 49 400 o en
//      3 s -- exactement la bonne cadence -- et QUE DES ZEROS : le navigateur
//      capturait une entree fantome. Un compteur d'octets est structurellement
//      aveugle a cette panne. On compte donc les octets NON NULS et la CRETE, et
//      on les renvoie au client (mic_stat) : « ca debite » et « ca porte du
//      signal » deviennent deux verdicts distincts.
//
//  (2) pacat MEURT EN SILENCE. `pacat -d <sink absent>` sort en rc=1
//      (« Stream error: No such entity ») -- mesure. Or le sink disparait pour
//      de vrai : lib/audio.sh fait `pkill -x pulseaudio`, et son dedoublonnage
//      decharge des module-null-sink. L'ancien code se contentait de journaliser
//      la fermeture : le bouton restait rouge et le navigateur poussait dans le
//      vide. On verifie le sink AVANT, on relance, et on PREVIENT le client.
//
//  (3) DEUX HORLOGES, AUCUN RESYNC. Le producteur est la carte son du poste
//      client, le consommateur le pulse du conteneur ; rien ne les accorde.
//      `stdin.write` tamponnait sans borne dans Node -> la latence montait tout
//      au long de l'appel sur une machine dont l'horloge micro est rapide
//      (« ca marche sur ce PC, la voix arrive en retard sur l'autre »). On borne
//      l'arriere et on jette au-dela, en comptant les rejets.
const MIC_SINK        = process.env.MIC_SINK || 'gsm_mic';
const MIC_LATENCY_MS  = parseInt(process.env.MIC_LATENCY_MSEC || '60');
// s16le 8 kHz mono = 16 octets par milliseconde. Toute la comptabilite de ce
// pont est en millisecondes d'audio, jamais en octets bruts.
const MIC_BYTES_PER_MS = 16;
const MIC_MAX_BACKLOG  = MIC_BYTES_PER_MS * parseInt(process.env.MIC_MAX_BACKLOG_MSEC || '240');
const MIC_MAX_RESPAWN  = parseInt(process.env.MIC_MAX_RESPAWN || '3');
const MIC_STAT_MS      = 1000;

function MicBridge() {
  this.pacat = null; this.owner = null; this.ws = null;
  this.stopping = false; this.respawns = 0;
  this.timer = null; this.healthTimer = null; this.statTimer = null;
  this._resetStats(); this.totalBytes = 0;
}
MicBridge.prototype._resetStats = function() {
  this.bytes = 0; this.nonzero = 0; this.peak = 0; this.dropped = 0;
};

// Le sink existe-t-il MAINTENANT ? pacat ne le dirait qu'apres coup, sur stderr,
// et start() aurait deja repondu « on ». 200 ms de pactl valent mieux qu'un
// bouton rouge menteur. En cas de doute (pactl muet/absent) on laisse passer :
// c'est pacat qui tranchera, et sa mort est desormais rapportee.
MicBridge.prototype._sinkPresent = function() {
  try {
    var out = execFileSync('pactl', ['list', 'short', 'sinks'],
                           { env: Object.assign({}, process.env, { PULSE_SERVER: PULSE_SERVER }),
                             timeout: 2000, encoding: 'utf-8' });
    return out.split('\n').some(function(l) { return l.split('\t')[1] === MIC_SINK; });
  } catch (e) { dbg('mic sink check: ' + e.message); return true; }
};

MicBridge.prototype._notify = function(on, reason, ws) {
  var target = ws || this.ws;
  if (!target || target.readyState !== WebSocket.OPEN) return;
  try {
    target.send(JSON.stringify({ type: 'mic_state', data: { on: on, reason: reason || '' }, ts: Date.now() }));
  } catch (e) {}
};

MicBridge.prototype._spawn = function() {
  var self = this;
  var env = Object.assign({}, process.env, { PULSE_SERVER: PULSE_SERVER });
  // --latency-msec bas : on veut de la conversation, pas du confort de buffer.
  var p = spawn('pacat', ['--playback', '-d', MIC_SINK, '--format=s16le',
                          '--rate=8000', '--channels=1', '--latency-msec=' + MIC_LATENCY_MS,
                          '--client-name=web-mic'],
                { env: env, stdio: ['pipe', 'ignore', 'pipe'] });
  this.pacat = p;
  p.stdin.on('error', function(e) { dbg('mic pacat stdin: ' + e.message); });
  p.stderr.on('data', function(d) { var m = d.toString().trim(); if (m) log('mic pacat: ' + m); });
  p.on('error', function(e) { log('mic pacat error: ' + e.message); });
  p.on('close', function(code) {
    if (self.pacat !== p) return;                 // deja remplace : rien a dire
    self.pacat = null;
    self._onDeath(code);
  });
  // Un flux qui tient 5 s est un flux sain : on rearme le credit de relances,
  // sinon une seule panne tardive epuiserait le compteur d'une session entiere.
  clearTimeout(this.healthTimer);
  this.healthTimer = setTimeout(function() { self.respawns = 0; }, 5000);
  return p;
};

MicBridge.prototype._onDeath = function(code) {
  var self = this;
  if (this.stopping || !this.owner) return;       // arret demande : normal
  log('mic bridge : pacat termine (' + code + ') — ' + this._statLine());
  if (this.respawns < MIC_MAX_RESPAWN) {
    this.respawns++;
    log('mic bridge : relance ' + this.respawns + '/' + MIC_MAX_RESPAWN + ' dans 500 ms');
    clearTimeout(this.timer);
    this.timer = setTimeout(function() { if (self.owner) self._spawn(); }, 500);
    return;
  }
  var who = this.ws;
  var reason = 'pacat s\'est arrete ' + (this.respawns + 1) + ' fois — sink « ' + MIC_SINK
             + ' » absent, ou PulseAudio du conteneur redemarre.';
  log('mic bridge : abandon — ' + reason);
  this._teardown();
  this._notify(false, reason, who);
};

MicBridge.prototype._statLine = function() {
  var ms = Math.round(this.bytes / MIC_BYTES_PER_MS);
  return this.bytes + ' o (' + ms + ' ms), ' + this.nonzero + ' non nuls, crete '
       + this.peak + ', ' + this.dropped + ' o jetes';
};

MicBridge.prototype._teardown = function() {
  clearTimeout(this.timer); clearTimeout(this.healthTimer);
  clearInterval(this.statTimer);
  this.timer = this.healthTimer = this.statTimer = null;
  this.owner = null; this.ws = null; this.stopping = false; this.respawns = 0;
};

// Renvoie { on, reason } : « on:true » ne veut plus dire « spawn tente », il veut
// dire « le sink existe et pacat a demarre ».
MicBridge.prototype.start = function(clientId, ws) {
  if (this.pacat && this.owner !== clientId)
    return { on: false, reason: 'un autre client tient deja le micro' };
  if (this.pacat) return { on: true, reason: '' };
  if (!this._sinkPresent()) {
    var r = 'sink « ' + MIC_SINK + ' » absent du PulseAudio du conteneur '
          + '(pactl list short sinks — attendu : gsm_audio ET gsm_mic).';
    log('mic bridge REFUSE : ' + r);
    return { on: false, reason: r };
  }
  // Une relance pouvait etre EN ATTENTE (pacat mort il y a moins de 500 ms) :
  // sans ce clearTimeout, elle se declenche apres notre _spawn() et lance un
  // SECOND pacat, dont le premier devient un orphelin qu'on ne nourrit plus.
  clearTimeout(this.timer); this.timer = null;
  this.owner = clientId; this.ws = ws; this.stopping = false; this.respawns = 0;
  this._resetStats(); this.totalBytes = 0;
  this._spawn();
  var self = this;
  clearInterval(this.statTimer);
  this.statTimer = setInterval(function() { self._pushStat(); }, MIC_STAT_MS);
  log('mic bridge start -> sink ' + MIC_SINK + ' (client ' + clientId + ')');
  return { on: true, reason: '' };
};

// Une fenetre d'une seconde, remise a zero a chaque envoi : le client affiche un
// etat INSTANTANE, pas un cumul depuis le debut (un cumul masque une panne qui
// survient en cours d'appel — c'est la regle « jamais de taux depuis un
// compteur cumulatif »).
MicBridge.prototype._pushStat = function() {
  if (!this.owner) return;
  var ms = Math.round(this.bytes / MIC_BYTES_PER_MS);
  this._notifyStat({ ms: ms, nonzero: this.nonzero, peak: this.peak,
                     droppedMs: Math.round(this.dropped / MIC_BYTES_PER_MS),
                     backlogMs: this.pacat && this.pacat.stdin
                                ? Math.round(this.pacat.stdin.writableLength / MIC_BYTES_PER_MS) : 0 });
  if (ms > 0 && this.nonzero === 0)
    log('mic bridge : ' + ms + ' ms recus, TOUS A ZERO — micro coupe ou entree fantome cote navigateur');
  this._resetStats();
};
MicBridge.prototype._notifyStat = function(data) {
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
  try { this.ws.send(JSON.stringify({ type: 'mic_stat', data: data, ts: Date.now() })); } catch (e) {}
};

MicBridge.prototype.write = function(buf, clientId) {
  if (!this.pacat || this.owner !== clientId) return;
  // Mesure AVANT tout rejet : on veut savoir si le navigateur envoie du signal,
  // meme quand le conteneur n'arrive pas a le consommer.
  this.bytes += buf.length; this.totalBytes += buf.length;
  for (var i = 0; i + 1 < buf.length; i += 2) {
    var v = buf.readInt16LE(i);
    if (v !== 0) this.nonzero++;
    var a = v < 0 ? -v : v;
    if (a > this.peak) this.peak = a;
  }
  // Garde-fou d'horloge : au-dela de MIC_MAX_BACKLOG_MSEC d'arriere, la trame
  // arriverait de toute facon trop tard pour une conversation. On la jette.
  var st = this.pacat.stdin;
  if (st.writableLength > MIC_MAX_BACKLOG) { this.dropped += buf.length; return; }
  try { st.write(buf); } catch (e) { dbg('mic write: ' + e.message); }
};

MicBridge.prototype.stop = function(clientId) {
  if (!this.owner || this.owner !== clientId) return;
  log('mic bridge stop (client ' + clientId + ', ' + this.totalBytes + ' o transmis)');
  this.stopping = true;
  var p = this.pacat; this.pacat = null;
  if (p) {
    try { p.stdin.end(); } catch (e) {}
    setTimeout(function() { try { p.kill('SIGKILL'); } catch (e) {} }, 500);
  }
  this._teardown();
};
var micBridge = new MicBridge();

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

/* [2026-08-09] RENDU DES WATERFALLS PILOTE PAR LE SERVEUR.
 * Palette, plage dynamique, zoom et sens etaient figes dans chaque page : trois
 * fichiers a editer et un rechargement pour essayer une variante. Ils vivent ici,
 * voyagent dans /psd (que les pages interrogent deja en continu) et se changent
 * A CHAUD via /fftcfg?palette=..&dr=..&zoom=..&dir=..
 * Au lancement : FFT_PALETTE, FFT_DR, FFT_ZOOM, FFT_WF_DIR. */
var FFT_PALETTE = String(process.env.FFT_PALETTE || 'inferno').toLowerCase();
var FFT_DR      = parseFloat(process.env.FFT_DR || '40');            // dB sous le max
var FFT_WF_DIR  = String(process.env.FFT_WF_DIR || 'down').toLowerCase();  // down = neuve EN HAUT
/* ZOOM : 1 = bande complete. 4 = quart central. Le rognage est fait ICI : les
 * points ecartes ne sont ni serialises ni transportes, donc zoomer ALLEGE le
 * flux, et l axe reste exact puisqu il est produit avec les donnees. */
var FFT_ZOOM    = Math.max(0.25, Math.min(64, parseFloat(process.env.FFT_ZOOM || '1')));
/* [2026-08-09] FLIP = retournement VERTICAL de la COURBE de spectre (pas de la
 * cascade : celle-la a son propre reglage, wfdir). Les deux etaient confondus
 * sous le mot « a l envers » et j ai corrige six fois le mauvais objet. */
/* [2026-08-09] Defaut REMIS A 0. Le retournement avait ete active pour redresser
 * FFT 3 — mais FFT 3 est une SOUSTRACTION psd(bts)-psd(ms) : son sens se corrige
 * dans le calcul, pas a l affichage. Retourner la courbe mettait a l envers les
 * deux autres FFT, qui elles etaient justes. Le bouton reste, en secours. */
var FFT_FLIP    = String(process.env.FFT_FLIP || '0') === '1';
/* GAIN = hauteur du trace en fraction du cadre. OFS = translation verticale,
 * meme unite. Separes a dessein : monter le gain deforme la cloche, la
 * translater ne fait que la deplacer — deux besoins distincts qu'un seul
 * reglage confondait. Garde-fou : gain+ofs est borne a 0.98 cote page, sinon
 * la crete sort du cadre. */
var FFT_GAIN    = Math.max(0.05, Math.min(0.98, parseFloat(process.env.FFT_GAIN || '0.85')));
var FFT_OFS     = Math.max(0.00, Math.min(0.90, parseFloat(process.env.FFT_OFS  || '0.12')));
const FFT_PALETTES = ['turbo','inferno','magma','viridis','gray'];
function fftCfg(){ return { palette:FFT_PALETTE, dr:FFT_DR, wfdir:FFT_WF_DIR,
                            zoom:FFT_ZOOM, flip:FFT_FLIP, gain:FFT_GAIN, ofs:FFT_OFS,
                            palettes:FFT_PALETTES }; }
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
  /* ZOOM : bins gardes autour du continu. Sous 1 il n y a rien de plus large
     que la bande complete — 0,5 et 0,25 rendent donc TOUTE la bande, sans
     rognage. C est une borne physique, pas un choix. */
  var keep = Math.min(half, Math.max(8, Math.round(half / FFT_ZOOM)));
  var kLo = half - keep, kHi = half + keep;
  for (var k = 0; k < FFT_NFFT; k += step) {
    if (k < kLo || k > kHi) continue;
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
    return { label: s.label, arfcn: s.arfcn, rate: FFT_RATE, freqs: r.freqs, psd: r.psd,
             palette: FFT_PALETTE, dr: FFT_DR, wfdir: FFT_WF_DIR, zoom: FFT_ZOOM,
             flip: FFT_FLIP, gain: FFT_GAIN, ofs: FFT_OFS };
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
  if (req.url.split('?')[0] === '/fftcfg') {        // lecture ET reglage a chaud
    var qs = new URLSearchParams(req.url.split('?')[1] || '');
    var pal = (qs.get('palette') || '').toLowerCase();
    var dr = parseFloat(qs.get('dr')), zm = parseFloat(qs.get('zoom'));
    if (pal && FFT_PALETTES.indexOf(pal) >= 0) FFT_PALETTE = pal;
    if (isFinite(dr)) FFT_DR = Math.max(6, Math.min(120, dr));
    if (isFinite(zm)) FFT_ZOOM = Math.max(0.25, Math.min(64, zm));
    if (qs.has('dir')) { var d = (qs.get('dir')||'').toLowerCase();
      if (d === 'up' || d === 'down') FFT_WF_DIR = d; }
    if (qs.has('flip')) FFT_FLIP = (qs.get('flip') === '1' || qs.get('flip') === 'true');
    var gn = parseFloat(qs.get('gain')), of = parseFloat(qs.get('ofs'));
    if (isFinite(gn)) FFT_GAIN = Math.max(0.05, Math.min(0.98, gn));
    if (isFinite(of)) FFT_OFS  = Math.max(0.00, Math.min(0.90, of));
    res.writeHead(200, { 'Content-Type':'application/json', 'Cache-Control':'no-store' });
    return res.end(JSON.stringify(fftCfg()));
  }
  var fp = req.url === '/' ? '/index.html' : req.url;
  fp = path.join(webDir, fp);
  var ct = MIME[path.extname(fp)] || 'application/octet-stream';
  fs.readFile(fp, function(err, data) {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    /* Pas de cache sur html/js/css : le serveur relit a chaque requete, mais le
       NAVIGATEUR gardait sa copie — des corrections verifiees sur le fil etaient
       absentes a l ecran. */
    var h = { 'Content-Type': ct };
    if (/\.(html|js|css)$/.test(fp)) {
      h['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      h['Pragma'] = 'no-cache'; h['Expires'] = '0';
    }
    res.writeHead(200, h);
    res.end(data);
  });
});

// ─── WebSocket Server ────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// ─── Capture IQ (cfile) : record/stop + commande grgsm_decode par type ──────
function recBroadcast(obj) {
  if (!obj.ts) obj.ts = Date.now();
  var m = JSON.stringify(obj);
  clients.forEach(function (c) { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(m); });
}
// Dernier Kc non nul vu : le Kc est effacé à l'idle (DM_EST/DM_REL) -> à l'arrêt
// d'un record il est souvent déjà à zéro. On garde le dernier Kc RÉEL pour que la
// commande « deciphered » (avec clé) reste exploitable.
var lastKc = null;
setInterval(function () {
  try {
    var b = fs.readFileSync('/dev/shm/calypso_kc');
    if (b.length >= 14 && b[4] >= 1 && b[4] <= 3 && !b.slice(6, 14).every(function (x) { return x === 0; })) {
      lastKc = { algo: b[4], spaced: Array.from(b.slice(6, 14)).map(function (x) { return x.toString(16).padStart(2, '0'); }).join(' '), tsMs: Date.now() };
    }
  } catch (e) {}
}, 250);
const recorder = require('./rec.js')({ broadcast: recBroadcast, log: log, getLastKc: function () { return lastKc; } });

// ─── État chiffrement A5 (badge dashboard) : ENCRYPTION du process + Kc live ──
function readA5Status() {
  var mode = '?', algo = 0, active = false;
  try {
    var pid = execFileSync('pgrep', ['-f', 'calypso-ipc-device -u']).toString().split('\n')[0].trim();
    if (pid) {
      var env = fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0');
      for (var i = 0; i < env.length; i++) if (env[i].indexOf('ENCRYPTION=') === 0) { mode = env[i].slice(11); break; }
    }
  } catch (e) {}
  try {
    var b = fs.readFileSync('/dev/shm/calypso_kc');
    if (b.length >= 14) { algo = b[4]; active = (algo >= 1) && !b.slice(6, 14).every(function (x) { return x === 0; }); }
  } catch (e) {}
  return { mode: mode, algo: algo, active: active };
}
setInterval(function () { var d = readA5Status(); d.lastKc = lastKc ? lastKc.spaced : ''; recBroadcast({ type: 'a5_status', data: d }); }, 3000);

wss.on('connection', function(ws, req) {
  log('Client connected from ' + req.socket.remoteAddress);
  var clientId      = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  var vtyMgr        = new VtySessionManager(ws);
  var tsharkSession = new TsharkSession(ws, clientId);
  var clientObj     = { ws: ws, vtyMgr: vtyMgr, tsharkSession: tsharkSession, clientId: clientId };
  clients.add(clientObj);

  ws.send(JSON.stringify({
    type: 'init',
    data: { operators: operators, activeOpIds: activeOpIds, vtyPorts: VTY_PORTS, tsharkActive: tsharkActiveClients > 0, a5: readA5Status() },
    ts: Date.now(),
  }));

  ws.on('message', function(raw, isBinary) {
    // Trames BINAIRES = PCM du micro navigateur. Le tableau de bord ne parle
    // que JSON (texte), donc aucune ambiguite : pas de sniffing de contenu.
    if (isBinary) { micBridge.write(raw, clientId); return; }
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
      case 'mic_start': {
        // start() rend { on, reason } : le client doit pouvoir AFFICHER pourquoi
        // le micro ne s'est pas arme, sinon la panne est indiscernable d'un
        // micro qui marche mais ne porte rien.
        var st = micBridge.start(clientId, ws);
        ws.send(JSON.stringify({ type: 'mic_state', data: st, ts: Date.now() }));
        break;
      }
      case 'mic_stop':
        micBridge.stop(clientId);
        ws.send(JSON.stringify({ type: 'mic_state', data: { on: false, reason: '' }, ts: Date.now() }));
        break;
      case 'poll':                   pollAll();                                        break;
      case 'record_start':           recorder.start(msg.source, { m: msg.m, t: msg.t }, ws); break;
      case 'record_stop':            recorder.stop(ws);                               break;
    }
  });

  ws.on('close', function() {
    clients.delete(clientObj);
    vtyMgr.closeAll();
    tsharkSession.stop();
    micBridge.stop(clientId);          // sinon pacat survit au client parti
    log('Client ' + clientId + ' disconnected');
  });
});

// ─── HTTPS : contexte securise, requis par getUserMedia (bouton micro) ──────
// getUserMedia n'existe que sur https:// ou http://localhost. Sans ce listener,
// le pont micro navigateur -> gsm_mic est inaccessible depuis une IP distante.
// Meme gestionnaire de requetes, meme WebSocket : on ajoute une porte, on ne
// deplace rien. Certificat auto-signe -> le navigateur avertira une fois.
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '443');
const TLS_CERT   = process.env.TLS_CERT || '/etc/osmo-web-tls/cert.pem';
const TLS_KEY    = process.env.TLS_KEY  || '/etc/osmo-web-tls/key.pem';
var httpsServer = null;
try {
  if (fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
    httpsServer = https.createServer(
      { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) },
      httpServer.listeners('request')[0]);
    // La MEME instance WebSocketServer sert les deux : sinon les clients https
    // n'auraient pas de WebSocket, donc ni VTY, ni tshark, ni micro.
    httpsServer.on('upgrade', function(req, sock, head) {
      wss.handleUpgrade(req, sock, head, function(ws) { wss.emit('connection', ws, req); });
    });
    httpsServer.listen(HTTPS_PORT, function() {
      log('HTTPS sur :' + HTTPS_PORT + ' (certificat auto-signe : le navigateur '
          + 'avertira une fois ; c\'est ce contexte securise qui autorise le micro)');
    });
    httpsServer.on('error', function(e) { log('HTTPS indisponible : ' + e.message); });
  } else {
    log('HTTPS non arme : certificat absent (' + TLS_CERT + '). Le bouton micro '
        + 'restera refuse par le navigateur hors http://localhost.');
  }
} catch (e) { log('HTTPS erreur : ' + e.message); }

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
