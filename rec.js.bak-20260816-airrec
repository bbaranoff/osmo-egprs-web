// rec.js — capture IQ (cfile) d'une fifo relais LIBRE + génère la commande grgsm_decode.
// [2026-08-15] Ajout « Capture IQ » du dashboard : record/stop -> path + commande
// grgsm_decode selon le type (ciphered = sans clé, deciphered = -e/-k <Kc live>).
// Sources = fifos IQ air SANS consommateur (le relais y fan-out le DL) : lecture
// sûre, ne vole aucune donnée à un décodeur vivant.
const fs   = require('fs');
const path = require('path');

const REC_DIR   = '/dev/shm/osmo-rec';       // PAS /tmp (porte les logs, piège tmpfs)
const SAMP      = 1083333;
const MAX_BYTES = 512 * 1024 * 1024;         // garde-fou ~60 s d'IQ
const KC_PATH   = '/dev/shm/calypso_kc';     // [4]algo [6..13]Kc(8)

const MODES = ['BCCH', 'BCCH_SDCCH4', 'SDCCH8', 'TCHF', 'TCHH'];
const SOURCES = {
  sdcch: { fifo: '/tmp/iq_grgsm_ciph.fifo',     m: 'BCCH_SDCCH4', t: 0, a: 514 },
  tch:   { fifo: '/tmp/iq_grgsm_tch_ciph.fifo', m: 'TCHF',        t: 3, a: 514, d: 'FR' },
};

let cur = null;

function readKc(getLastKc) {
  try {
    const b = fs.readFileSync(KC_PATH);
    if (b.length >= 14) {
      const algo = b[4];
      const kc = b.slice(6, 14);
      if (algo !== 0 && !kc.every(function (x) { return x === 0; })) {
        const spaced = Array.from(kc).map(function (x) { return x.toString(16).padStart(2, '0'); }).join(' ');
        return { present: true, algo: algo, spaced: spaced, fromCache: false, ageMs: 0 };
      }
    }
  } catch (e) {}
  const last = getLastKc && getLastKc();
  if (last) return { present: true, algo: last.algo, spaced: last.spaced, fromCache: true, ageMs: Date.now() - last.tsMs };
  return { present: false, algo: 0, spaced: '' };
}

function buildCmds(cfg, file, kc, m, t) {
  const isTch = /^TCH/.test(m);
  const base = 'grgsm_decode -m ' + m + ' -t ' + t + ' -a ' + cfg.a + ' -s ' + SAMP +
               (isTch ? ' -d FR' : '') + ' -c ' + file + ' -v';
  return {
    // CIPHERED : bursts bruts démodulés (-p), SANS clé -> la garbage vue sur l'air,
    // exactement comme une vraie capture d'un canal chiffré A5/1.
    ciphered:   base + ' -p',
    // DECIPHERED : avec la clé -> le clair.
    deciphered: kc.present ? (base + ' -e ' + kc.algo + ' -k ' + kc.spaced)
                           : (base + '   # Kc absent : lance une session chiffrée puis re-record'),
  };
}

function sanitizeKc(str) {
  if (!str) return '';
  var m = String(str).match(/[0-9a-fA-F]{2}/g);
  if (!m || m.length < 8) return '';
  return m.slice(0, 8).map(function (b) { return b.toLowerCase(); }).join(' ');
}

module.exports = function (deps) {
  const broadcast = deps.broadcast;
  const log = deps.log || function () {};
  const getLastKc = deps.getLastKc || function () { return null; };

  function status() {
    return cur
      ? { running: true, source: cur.source, bytes: cur.bytes,
          seconds: Math.round((Date.now() - cur.startMs) / 1000), path: cur.file }
      : { running: false };
  }
  function bcastStatus() { broadcast({ type: 'rec_status', data: status() }); }

  function start(source, opts, ws) {
    opts = opts || {};
    if (cur) { ws.send(JSON.stringify({ type: 'rec_error', data: { msg: 'enregistrement déjà en cours' }, ts: Date.now() })); return; }
    const cfg = SOURCES[source] || SOURCES.sdcch;
    if (!fs.existsSync(cfg.fifo)) { ws.send(JSON.stringify({ type: 'rec_error', data: { msg: 'fifo absente : ' + cfg.fifo }, ts: Date.now() })); return; }
    try { fs.mkdirSync(REC_DIR, { recursive: true }); } catch (e) {}
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const file = path.join(REC_DIR, 'air_' + source + '_' + stamp + '.cfile');
    let rs, out;
    try { rs = fs.createReadStream(cfg.fifo); out = fs.createWriteStream(file); }
    catch (e) { ws.send(JSON.stringify({ type: 'rec_error', data: { msg: 'open: ' + e.message }, ts: Date.now() })); return; }
    var m = (MODES.indexOf(opts.m) >= 0) ? opts.m : cfg.m;
    var t = (opts.t != null && opts.t >= 0 && opts.t <= 7) ? (opts.t | 0) : cfg.t;
    cur = { source: source, cfg: cfg, file: file, rs: rs, out: out, bytes: 0, startMs: Date.now(), owner: ws, m: m, t: t, kcManual: sanitizeKc(opts.kc) };
    rs.on('data', function (chunk) {
      cur.bytes += chunk.length;
      out.write(chunk);
      if (cur.bytes >= MAX_BYTES) stop(ws, 'plafond ' + MAX_BYTES + ' o atteint');
    });
    rs.on('error', function (e) { log('rec read err ' + e.message); stop(ws, 'erreur lecture: ' + e.message); });
    cur.timer = setInterval(bcastStatus, 1000);
    log('rec start ' + file + ' <- ' + cfg.fifo);
    bcastStatus();
  }

  function stop(ws, note) {
    if (!cur) { if (ws) ws.send(JSON.stringify({ type: 'rec_status', data: { running: false }, ts: Date.now() })); return; }
    const c = cur; cur = null;
    clearInterval(c.timer);
    try { c.rs.destroy(); } catch (e) {}
    try { c.out.end(); } catch (e) {}
    const kc = c.kcManual
      ? { present: true, algo: 1, spaced: c.kcManual, fromCache: false, ageMs: 0, manual: true }
      : readKc(getLastKc);
    const cmds = buildCmds(c.cfg, c.file, kc, c.m, c.t);
    broadcast({ type: 'rec_result', data: {
      path: c.file, bytes: c.bytes, seconds: Math.round((Date.now() - c.startMs) / 1000),
      source: c.source, mode: c.m, timeslot: c.t, kcPresent: kc.present, kcAlgo: kc.algo, kc: kc.spaced,
      kcFromCache: kc.fromCache || false, kcAgeMs: kc.ageMs || 0, kcManual: kc.manual || false,
      cmdCiphered: cmds.ciphered, cmdDeciphered: cmds.deciphered, note: note || '',
      hint: 'Port GSMTAP 4729 requis LIBRE pour décoder : stoppe le décodeur SDCCH live (pgrep -f "grgsm_decode -m BCCH_SDCCH4") ou décode sur une autre machine, sinon "bind: Address already in use".',
    } });
    bcastStatus();
    log('rec stop ' + c.file + ' ' + c.bytes + ' o');
  }

  return { start: start, stop: stop, status: status };
};
