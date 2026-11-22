// conf-api.js - configuration and control of the bench, for the web console
// ============================================================================
// The data is osmo-operator's SQL base (tools/osmo-db.py, SQLite): it reads the
// configuration files where they live (/etc/osmocom, /root/.osmocom/bb,
// /etc/asterisk...), follows them when they change, and checks the SQL rules
// between them (stick/ARFCN, band, unit-id, MCC/MNC, NS 23000, GTP, GSUP...).
// globals.conf is the layer written over them: the page edits it here.
//
//   GET  /api/conf                 parameters (globals.conf), files, history, rules
//   GET  /api/conf/ran             BTS and MS (HLR subscribers + mobile configs)
//   GET  /api/conf/core            core daemons and their key lines
//   GET  /api/conf/fichier?chemin= one file (content, parsed lines)
//   POST /api/conf/set     {cle, valeur}     globals.conf (validated: choices...)
//   POST /api/conf/reset   {cle}             back to globals.conf.example
//   POST /api/conf/ecrire  {chemin, contenu} replace a followed file (backup .bak-<date>)
//   GET  /api/banc                 state: units, processes, start command
//   POST /api/banc/start   {regen}           start.sh --config (regen: OSMO_CONFIGURE=1,
//                                            configurations rewritten like --configure)
//   POST /api/banc/stop
//   GET  /api/banc/journal         the last lines of the start
//
// Writes and start/stop: from this machine only, unless OSMO_WEB_CONF_LAN=1.
// Nothing here restarts a daemon by itself: globals.conf and the files are
// used by the next start (with regen to rewrite the derived configurations).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const OPERATOR = process.env.OSMO_OPERATOR_DIR || '/opt/GSM/osmo-operator';
const DB_PY    = path.join(OPERATOR, 'tools', 'osmo-db.py');
const START_SH = path.join(OPERATOR, 'start.sh');
const UNIT     = 'osmo-banc-web';
const LAN_OK   = process.env.OSMO_WEB_CONF_LAN === '1';
const PROCS    = ['osmo-stp', 'osmo-hlr', 'osmo-mgw', 'osmo-msc', 'osmo-bsc', 'osmo-bts-trx', 'osmo-bts-virtual',
                  'osmo-sgsn', 'osmo-ggsn', 'osmo-pcu', 'osmo-sip-connector', 'asterisk', 'c54x_exe',
                  'qemu-system-arm', 'osmocon', 'mobile', 'trxcon', 'transceiver', 'virtphy'];

function run(cmd, args, opts) {
  return new Promise(function (resolve) {
    const p = execFile(cmd, args, Object.assign({ timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, opts || {}),
      function (err, stdout, stderr) { resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' }); });
    if (opts && opts.input != null) { p.stdin.end(opts.input); }
  });
}

async function db(args, input) {
  const r = await run('python3', [DB_PY].concat(args), input != null ? { input: input } : undefined);
  if (r.code !== 0) { const e = new Error((r.stderr || r.stdout).trim() || ('osmo-db.py ' + args[0] + ' : echec')); e.status = 400; throw e; }
  return r.stdout;
}

// "This machine" = any of ITS OWN addresses (loopback and interfaces): a
// browser on the bench that opens the page by the machine's IP comes from that
// IP, not from 127.0.0.1 - it was refused (stop/start did nothing).
const os = require('os');
function adressesLocales() {
  const out = new Set(['127.0.0.1', '::1']);
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (n) { (ifs[n] || []).forEach(function (i) { out.add(i.address); }); });
  return out;
}
function adresse(req) { return String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''); }
function local(req) {
  return LAN_OK || adressesLocales().has(adresse(req));
}

function body(req) {
  return new Promise(function (resolve, reject) {
    let b = '';
    req.on('data', function (c) { b += c; if (b.length > 8 * 1024 * 1024) { reject(new Error('corps trop gros')); req.destroy(); } });
    req.on('end', function () { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

function send(res, code, obj) {
  const b = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': b.length });
  res.end(b);
}

async function etatBanc() {
  const out = { units: {}, processus: {}, systemd: fs.existsSync('/run/systemd/system') };
  for (const u of ['osmo-banc', UNIT]) {
    const r = await run('systemctl', ['is-active', u]);
    out.units[u] = r.stdout.trim() || 'inconnu';
  }
  const r = await run('pgrep', ['-a', '-f', PROCS.map(function (p) { return '(^|/)' + p + '( |$)'; }).join('|')]);
  r.stdout.split('\n').filter(Boolean).forEach(function (l) {
    const m = /^(\d+)\s+(\S+)/.exec(l); if (!m) return;
    const nom = PROCS.find(function (p) { return path.basename(m[2]) === p || l.indexOf('/' + p + ' ') >= 0; }) || path.basename(m[2]);
    (out.processus[nom] = out.processus[nom] || []).push(+m[1]);
  });
  const c = await run('bash', [path.join(OPERATOR, 'tools', 'start-config.sh'), '--print']);
  out.commande = c.code === 0 ? c.stdout.trim() : null;
  out.start_config = (await run('bash', [path.join(OPERATOR, 'tools', 'start-config.sh'), '--path'])).stdout.trim();
  out.actif = Object.keys(out.processus).some(function (p) { return /^osmo-(msc|bsc)$/.test(p); })
              || out.units[UNIT] === 'active' || out.units['osmo-banc'] === 'active';
  return out;
}

// The environment of start.sh, for start AND stop. A systemd service has no
// HOME (no User=): start.sh runs under set -u and died at once on
// environment/paths.env ("HOME: unbound variable") - the stop button stopped
// nothing and said OK.
function envBanc(extra) {
  return Object.assign({ HOME: '/root', USER: 'root', LOGNAME: 'root', VIRTUAL_ENV: '/root/.env',
    PATH: '/root/.env/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    PULSE_SERVER: 'unix:/var/run/pulse/native', NO_MENU: '1', CALYPSO_NO_ATTACH: '1', NO_COLOR: '1',
    OSMO_NO_TERM: '1', OSMO_LAUNCH_APPS: '0' }, extra || {});
}

async function demarrer(regen) {
  const cfg = fs.existsSync((await run('bash', [path.join(OPERATOR, 'tools', 'start-config.sh'), '--path'])).stdout.trim());
  const args = [START_SH].concat(cfg ? ['--config'] : []).concat(['--no-attach']);
  const env = envBanc({ OSMO_CONFIGURE: regen ? '1' : '0' });
  if (fs.existsSync('/run/systemd/system')) {
    await run('systemctl', ['stop', UNIT]); await run('systemctl', ['reset-failed', UNIT]);
    const setenv = Object.keys(env).map(function (k) { return '--setenv=' + k + '=' + env[k]; });
    const r = await run('systemd-run', ['--unit=' + UNIT, '--no-block', '--collect', '-p', 'Type=oneshot',
      '-p', 'RemainAfterExit=yes', '-p', 'TimeoutStartSec=infinity',
      '--working-directory=' + OPERATOR].concat(setenv).concat(['/bin/bash']).concat(args));
    if (r.code !== 0) throw new Error('systemd-run : ' + (r.stderr || r.stdout));
    return { lance: args.join(' '), unite: UNIT, regen: !!regen };
  }
  const log = fs.openSync('/tmp/osmo-banc-web.log', 'w');
  spawn('/bin/bash', args, { cwd: OPERATOR, env: Object.assign({}, process.env, env), detached: true, stdio: ['ignore', log, log] }).unref();
  return { lance: args.join(' '), journal: '/tmp/osmo-banc-web.log', regen: !!regen };
}

async function arreter() {
  const r = await run('/bin/bash', [START_SH, '--stop'], { cwd: OPERATOR, timeout: 120000, env: envBanc() });
  if (fs.existsSync('/run/systemd/system')) { await run('systemctl', ['stop', UNIT, 'osmo-banc']); }
  const sortie = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').slice(-40).join('\n');
  console.log('[banc] start.sh --stop -> code ' + r.code + '\n' + sortie.split('\n').slice(-8).join('\n'));
  if (r.code !== 0) { const e = new Error('start.sh --stop a echoue (code ' + r.code + ') :\n' + sortie.split('\n').slice(-6).join('\n')); e.status = 500; throw e; }
  return { code: r.code, sortie: sortie };
}

async function journal() {
  if (fs.existsSync('/run/systemd/system')) {
    const r = await run('journalctl', ['-u', UNIT, '-u', 'osmo-banc', '-n', '300', '--no-pager', '-o', 'cat']);
    return { texte: r.stdout };
  }
  try { return { texte: fs.readFileSync('/tmp/osmo-banc-web.log', 'utf8').split('\n').slice(-300).join('\n') }; }
  catch (e) { return { texte: '' }; }
}

// -> true if the request was for this module
function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/api/conf') && !u.pathname.startsWith('/api/banc')) return false;
  const ecrit = req.method === 'POST';
  if (ecrit && !local(req)) { send(res, 403, { erreur: 'refuse depuis ' + adresse(req) + ' : demarrer/arreter et modifier sont reserves a cette machine (Environment=OSMO_WEB_CONF_LAN=1 dans osmo-egprs-web.service pour ouvrir au reseau)' }); return true; }
  (async function () {
    switch (req.method + ' ' + u.pathname) {
      case 'GET /api/conf':          return send(res, 200, await db(['json', 'etat']));
      case 'GET /api/conf/ran':      return send(res, 200, await db(['json', 'ran']));
      case 'GET /api/conf/core':     return send(res, 200, await db(['json', 'core']));
      case 'GET /api/conf/fichier':  return send(res, 200, await db(['json', 'fichier', u.searchParams.get('chemin') || '']));
      case 'POST /api/conf/set':     { const b = await body(req); await db(['set', String(b.cle), String(b.valeur == null ? '' : b.valeur), 'web']); return send(res, 200, { ok: true }); }
      case 'POST /api/conf/reset':   { const b = await body(req); await db(['reset', String(b.cle), 'web']); return send(res, 200, { ok: true }); }
      case 'POST /api/conf/ecrire':  { const b = await body(req); const o = await db(['ecrire', String(b.chemin), 'web'], String(b.contenu || '')); return send(res, 200, { ok: true, message: o.trim() }); }
      case 'GET /api/banc':          return send(res, 200, await etatBanc());
      case 'POST /api/banc/start':   { const b = await body(req); return send(res, 200, await demarrer(!!b.regen)); }
      case 'POST /api/banc/stop':    return send(res, 200, await arreter());
      case 'GET /api/banc/journal':  return send(res, 200, await journal());
      default:                       return send(res, 404, { erreur: 'inconnu : ' + req.method + ' ' + u.pathname });
    }
  })().catch(function (e) { send(res, e.status || 500, { erreur: String(e.message || e) }); });
  return true;
}

module.exports = { handle: handle };
