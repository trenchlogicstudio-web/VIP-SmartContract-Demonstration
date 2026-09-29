// VIP SmartContract · MVP v0.2.11 · web layer
// AS-IS evaluation artifact — 09_AS_IS_Notice of the VIP SmartContract package governs.
//
// Two surfaces, deliberately separated:
//   /v3/*   the architecture contract from 04_API_Spec.yaml. Six routes, at
//           the paths, status codes and error identifiers of registry slot
//           04b_Integration_Reference.js. This is what a buyer implements in
//           their own platform.
//   /vip/*  the product surface of THIS running system: the operations a
//           resort performs around the policy. Not part of the specification.
// The HTML pages are the evaluation console and use only the two surfaces
// above — there is no hidden third path into the data.
'use strict';
const http = require('http');
const P = require('./policy');
const E = require('./engine');
const B = require('./boundary');

const ADMIN_TOKEN = process.env.VIP_ADMIN_TOKEN || 'evaluation-only';
// The build reads its own version from package.json, the one place the code
// takes it from, so a page header cannot trail the artifact it describes.
const VERSION = require('../package.json').version;

// Every text value a page script writes into markup passes through esc(); numbers
// are written as formatted numbers. The host console lists vip_ids, and a vip_id is
// whatever string a caller armed a session with — written raw into innerHTML it ran
// as markup in the host's browser. Values reach click handlers through data
// attributes, never through a string spliced into inline script.
const ESC = String.raw`const esc=v=>String(v).replace(/[&<>"'\\]/g,c=>'&#'+c.charCodeAt(0)+';');`;

const SPEC_ROUTES = ['POST /v3/precommit', 'POST /v3/session/tick', 'GET /v3/policy/state',
                     'POST /v3/redirect/issue', 'GET /v3/audit/{session_id}',
                     'POST /v3/programme/suppress'];

// ── presentation ──────────────────────────────────────────────────────────
// No external stylesheet, no web font, no network call of any kind: the
// console runs on an air-gapped evaluation machine exactly as it runs online.
const CSS = `
:root{--bg:#12141a;--panel:#1a1d26;--fg:#e8e6e1;--dim:#8b8f9c;--line:#2c3040;
      --ok:#4fa87a;--warn:#c9a227;--stop:#c0503f;--accent:#6f8fd6}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
     font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
     font-size:15px;line-height:1.5}
header{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;
       flex-wrap:wrap;gap:12px;align-items:baseline}
header h1{font-size:17px;margin:0;letter-spacing:.02em}
header .v{color:var(--dim);font-size:13px}
nav a{color:var(--accent);text-decoration:none;margin-right:14px;font-size:14px}
main{padding:22px;max-width:1040px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;
       padding:16px;margin-bottom:16px;overflow-x:auto}
.panel h2{font-size:14px;margin:0 0 12px;text-transform:uppercase;
          letter-spacing:.08em;color:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}td.id{overflow-wrap:anywhere;min-width:10ch}
th{color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.num{text-align:right;font-variant-numeric:tabular-nums}
button{background:var(--accent);color:#0d1017;border:0;border-radius:5px;
       padding:7px 12px;font-size:14px;cursor:pointer;margin:2px 4px 2px 0}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
button.stop{background:var(--stop);color:#fff}
input,select{background:#0f1117;color:var(--fg);border:1px solid var(--line);
             border-radius:5px;padding:7px 9px;font-size:14px;margin:2px 4px 2px 0}
.meter{height:14px;background:#0f1117;border:1px solid var(--line);border-radius:7px;
       overflow:hidden;margin:8px 0;position:relative}
.meter i{display:block;height:100%;background:var(--ok)}
.meter i.warn{background:var(--warn)}
.meter i.stop{background:var(--stop)}
.tag{display:inline-block;font-size:11px;padding:2px 7px;border-radius:10px;
     border:1px solid var(--line);color:var(--dim);margin-right:6px}
.tag.live{color:var(--ok);border-color:var(--ok)}
.tag.stopped{color:var(--stop);border-color:var(--stop)}
.tag.warn{color:var(--warn);border-color:var(--warn)}
.note{color:var(--dim);font-size:13px}
pre{background:#0f1117;border:1px solid var(--line);border-radius:6px;padding:12px;
    overflow:auto;font-size:12.5px;max-height:340px}
footer{padding:16px 22px;border-top:1px solid var(--line);color:var(--dim);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.kpi{background:#0f1117;border:1px solid var(--line);border-radius:6px;padding:12px}
.kpi b{display:block;font-size:21px;font-variant-numeric:tabular-nums;margin-bottom:3px}
.kpi span{color:var(--dim);font-size:12px}
`;

function page(title, nav, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · VIP SmartContract MVP v${VERSION}</title><style>${CSS}</style></head><body>
<header><h1>VIP SmartContract · ${title}</h1><span class="v">MVP v${VERSION} · evaluation instance</span>
<nav>${nav}</nav></header><main>${body}</main>
<footer>SOLD AS-IS · SYNTHETIC BY DECLARATION · seeded figures reproduce the canon reference preset and are
not a measurement of any operator · Trench Logic Studio</footer></body></html>`;
}
const NAV = '<a href="/">Guest</a><a href="/host">Host console</a><a href="/admin">Admin</a>';

// ── pages ─────────────────────────────────────────────────────────────────
function guestPage() {
  return page('Guest screen', NAV, `
<div class="panel"><h2>Pre-commit</h2>
  <p class="note">The guest sets the number before the session. The engine publishes the euro
  amount at which the policy fires, so the limit is known in advance rather than discovered at the stop.</p>
  <input id="vip" placeholder="vip_id" value="VIP-D02">
  <input id="budget" type="number" placeholder="budget_eur" value="8000">
  <select id="mode"><option value="hard_stop">hard_stop</option><option value="advisory" selected>advisory</option></select>
  <button onclick="pre()">Arm policy</button>
  <span class="note">POST /v3/precommit</span>
</div>
<div class="panel"><h2>Live session</h2>
  <div id="meterwrap"></div>
  <button onclick="tick(500)">Session tick +500</button>
  <button onclick="tick(1500)">+1500</button>
  <button class="stop" onclick="vstop()">Stop now, voluntarily</button>
  <button class="ghost" onclick="load()">Refresh state</button>
  <div id="state"></div>
</div>
<div class="panel"><h2>Response</h2><pre id="out">—</pre></div>
<script>
${ESC}
const $=s=>document.querySelector(s);
const show=o=>{$('#out').textContent=JSON.stringify(o,null,2)};
async function call(m,u,b){const r=await fetch(u,{method:m,headers:{'content-type':'application/json'},
  body:b?JSON.stringify(b):undefined});const j=await r.json();show({status:r.status,body:j});return j}
function pre(){call('POST','/v3/precommit',{vip_id:$('#vip').value,budget_eur:Number($('#budget').value),
  mode:$('#mode').value}).then(load)}
function tick(d){call('POST','/v3/session/tick',{vip_id:$('#vip').value,delta_eur:d}).then(load)}
function vstop(){call('POST','/vip/session/stop',{vip_id:$('#vip').value}).then(load)}
async function load(){
  const r=await fetch('/v3/policy/state?vip_id='+encodeURIComponent($('#vip').value));
  const s=await r.json();
  if(!r.ok){$('#state').innerHTML='<p class="note">'+esc(s.error||'no session')+'</p>';$('#meterwrap').innerHTML='';return}
  const pct=Math.round(s.consumed_fraction*1000)/10;
  const cls=s.stopped?'stop':(s.escalate_active?'warn':(s.nudge_active?'warn':''));
  $('#meterwrap').innerHTML='<div class="meter"><i class="'+cls+'" style="width:'+Math.min(100,pct)+'%"></i></div>'+
    '<span class="tag '+(s.stopped?'stopped':'live')+'">'+(s.stopped?'STOPPED':'LIVE')+'</span>'+
    '<span class="tag">'+esc(s.mode)+'</span>'+(s.nudge_active?'<span class="tag warn">NUDGE</span>':'')+
    (s.escalate_active?'<span class="tag warn">ESCALATE</span>':'')+
    '<span class="tag">'+pct+'% of budget</span>';
  $('#state').innerHTML='<table><tr><th>Budget</th><td class="num">'+s.budget_eur.toFixed(2)+'</td>'+
    '<th>Consumed</th><td class="num">'+s.consumed_eur.toFixed(2)+'</td></tr>'+
    '<tr><th>Distance to threshold</th><td class="num">'+s.distance_to_threshold_eur.toFixed(2)+'</td>'+
    '<th>Session</th><td>'+esc(s.session_id.slice(0,8))+'</td></tr>'+
    '<tr><th>Stop now and you earn</th><td class="num">'+s.incentive_preview.redirect_eur.toFixed(2)+' resort credit</td>'+
    '<th>plus rollover</th><td class="num">'+s.incentive_preview.rollover_eur.toFixed(2)+'</td></tr>'+
    '<tr><th>returned to you</th><td class="num">'+s.incentive_preview.residual_to_guest_eur.toFixed(2)+'</td>'+
    '<th></th><td class="note">the residual is the guest\\'s own money</td></tr></table>';
}
load();
</script>`);
}

function hostPage() {
  return page('Host console', NAV, `
<div class="panel"><h2>Live sessions</h2>
  <p class="note">Advisory mode escalates to the host with the numbers already computed. The host
  carries the moment; the engine supplies what stopping now is worth.</p>
  <div id="live"></div></div>
<div class="panel"><h2>Stopped sessions · issued credit</h2>
  <p class="note">Redemption is the point at which preserved gaming budget becomes non-gaming revenue.
  Until then the redirect figure is an issuance, not a sale.</p>
  <input id="vip" placeholder="vip_id" value="VIP-0001"><button onclick="credits()">Show credits</button>
  <div id="credits"></div></div>
<div class="panel"><h2>Response</h2><pre id="out">—</pre></div>
<script>
${ESC}
const $=s=>document.querySelector(s);
const show=o=>{$('#out').textContent=JSON.stringify(o,null,2)};
async function call(m,u,b){const r=await fetch(u,{method:m,headers:{'content-type':'application/json'},
  body:b?JSON.stringify(b):undefined});const j=await r.json();show({status:r.status,body:j});return j}
async function live(){
  const r=await fetch('/vip/sessions');const j=await r.json();
  $('#live').innerHTML='<table><tr><th>VIP</th><th>Mode</th><th class="num">Budget</th><th class="num">Consumed</th>'+
    '<th class="num">To threshold</th><th>Signal</th><th class="num">Worth stopping</th><th></th></tr>'+
    j.live.map(s=>'<tr><td class="id">'+esc(s.vip_id)+'</td><td>'+esc(s.mode)+'</td><td class="num">'+s.budget_eur.toFixed(0)+'</td>'+
      '<td class="num">'+s.consumed_eur.toFixed(0)+'</td><td class="num">'+s.distance_to_threshold_eur.toFixed(0)+'</td>'+
      '<td>'+(s.escalate_active?'<span class="tag warn">ESCALATE</span>':(s.nudge_active?'<span class="tag warn">NUDGE</span>':'<span class="tag live">quiet</span>'))+'</td>'+
      '<td class="num">'+s.incentive_preview.redirect_eur.toFixed(2)+'</td>'+
      '<td><button data-stop="'+esc(s.vip_id)+'">Guest stops</button></td></tr>').join('')+'</table>';
}
$('#live').addEventListener('click',e=>{const b=e.target.closest('button[data-stop]');if(b)stop(b.dataset.stop)});
function stop(v){call('POST','/vip/session/stop',{vip_id:v}).then(live)}
async function credits(){
  const v=$('#vip').value;const r=await fetch('/vip/credits?vip_id='+encodeURIComponent(v));const j=await r.json();
  if(!r.ok){$('#credits').innerHTML='<p class="note">'+esc(j.error||'none')+'</p>';return}
  $('#credits').innerHTML='<table><tr><th>#</th><th>Category</th><th class="num">Amount</th><th>State</th><th></th></tr>'+
    j.credits.map(c=>'<tr><td>'+esc(c.id)+'</td><td>'+esc(c.category)+'</td><td class="num">'+c.amount_eur.toFixed(2)+'</td>'+
      '<td>'+(c.redeemed_at?'<span class="tag">redeemed</span>':'<span class="tag live">issued</span>')+'</td>'+
      '<td>'+(c.redeemed_at?'':'<button data-redeem="'+esc(c.id)+'">Redeem</button>')+'</td></tr>').join('')+
    '</table><p class="note">Rollover held: '+j.rollover_eur.toFixed(2)+
    ' <button class="ghost" data-roll="'+esc(v)+'">Apply rollover</button></p>';
}
$('#credits').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
  if(b.dataset.redeem)redeem(Number(b.dataset.redeem));if(b.dataset.roll!==undefined)roll(b.dataset.roll)});
function redeem(id){call('POST','/vip/credit/redeem',{credit_id:id}).then(credits)}
function roll(v){call('POST','/vip/rollover/apply',{vip_id:v}).then(credits)}
live();
</script>`);
}

function adminPage(token) {
  return page('Admin', NAV, `
<div class="panel"><h2>Quarter roll-up</h2>
  <p class="note">Every figure below is computed from this instance's own rows, with its denominator stated.
  The seeded quarter reproduces the canon reference preset; it is synthetic by declaration.</p>
  <div id="q" class="grid"></div><div id="qd"></div></div>
<div class="panel"><h2>Canon comparison figures</h2>
  <p class="note">These are ANCHORED assumptions and one EMPIRICAL figure carried from the canon. They are
  not produced by this build and must never be read as its output.</p>
  <table>
   <tr><th>Retention under incentive</th><td class="num">0.84</td><td class="note">ANCHORED — share of limited VIPs retained over the quarter, band 0.61–0.92</td></tr>
   <tr><th>Retention, hard stop only</th><td class="num">0.61</td><td class="note">share of limited VIPs retained over the quarter without the incentive layer — the fixed baseline</td></tr>
   <tr><th>Post-stop churn</th><td class="num">0.39 &rarr; 0.16</td><td class="note">ANCHORED — share of stopped players lost within the quarter, without and then with the incentive layer</td></tr>
   <tr><th>Host hours index</th><td class="num">38</td><td class="note">ANCHORED — indexed against the buyer's own baseline of 100</td></tr>
   <tr><th>Limit-setter odds ratio</th><td class="num">2.92</td><td class="note">EMPIRICAL — odds of limit-setters remaining active at one year, from peer-reviewed responsible-gambling literature. The only non-synthetic figure in the package; never this build's own result</td></tr>
  </table></div>
<div class="panel"><h2>Audit chain</h2>
  <button onclick="verify()">Verify from genesis to head</button>
  <span class="note">GET /vip/chain/verify</span><div id="chain"></div></div>
<div class="panel"><h2>Erasure</h2>
  <p class="note">The display name is the only field that names a person. Erasure nulls it and leaves the
  chain valid, because no payload ever carried it.</p>
  <input id="vip" placeholder="vip_id" value="VIP-0002">
  <button class="stop" onclick="erase()">Erase guest</button>
  <span class="note">POST /vip/guest/erase · admin token</span></div>
<div class="panel"><h2>Running configuration</h2><pre id="cfg">—</pre></div>
<div class="panel"><h2>Response</h2><pre id="out">—</pre></div>
<script>
${ESC}
const TOKEN=${JSON.stringify(token).replace(/</g, '\\u003c')};
const $=s=>document.querySelector(s);
const show=o=>{$('#out').textContent=JSON.stringify(o,null,2)};
async function call(m,u,b){const r=await fetch(u,{method:m,headers:{'content-type':'application/json',
  'x-admin-token':TOKEN},body:b?JSON.stringify(b):undefined});const j=await r.json();
  show({status:r.status,body:j});return j}
async function quarter(){
  const j=await (await fetch('/vip/quarter')).json();
  $('#q').innerHTML=[['Stopped sessions',j.stopped_sessions_in_quarter],
    ['Preserved',j.preserved_eur.toLocaleString()+' EUR'],
    ['Redirected',j.redirected_eur.toLocaleString()+' EUR'],
    ['Rollover liability',j.rollover_liability_eur.toLocaleString()+' EUR'],
    ['Returned to guests',j.residual_to_guests_eur.toLocaleString()+' EUR'],
    ['Non-gaming capture',(j.non_gaming_capture*100).toFixed(0)+'%']]
    .map(k=>'<div class="kpi"><b>'+esc(k[1])+'</b><span>'+esc(k[0])+'</span></div>').join('');
  $('#qd').innerHTML='<p class="note">Capture denominator: '+esc(j._non_gaming_capture_denominator)+
    '<br>Credit issued '+j.credits_issued.eur.toLocaleString()+' EUR in '+j.credits_issued.count+
    ' instruments; redeemed '+j.credits_redeemed.eur.toLocaleString()+' EUR in '+j.credits_redeemed.count+
    '. '+esc(j._redeemed_denominator)+'<br>Live sessions outside the quarter: '+esc(j.live_sessions_outside_quarter)+'</p>';
}
async function verify(){const j=await (await fetch('/vip/chain/verify')).json();
  $('#chain').innerHTML='<p><span class="tag '+(j.valid?'live':'stopped')+'">'+(j.valid?'VALID':'BROKEN')+
  '</span> length '+esc(j.length)+' · head '+esc(String(j.head||'').slice(0,16))+'</p>';show(j)}
function erase(){call('POST','/vip/guest/erase',{vip_id:$('#vip').value}).then(quarter)}
(async()=>{$('#cfg').textContent=JSON.stringify(await (await fetch('/vip/config')).json(),null,2)})();
quarter();
</script>`);
}

// ── server ────────────────────────────────────────────────────────────────
function createServer(db) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const html = s => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(s); };

      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return send(400, { error: 'BAD_REQUEST' }); }
      const path = url.pathname;
      let payload = {};
      if (body) { try { payload = JSON.parse(body); } catch { return send(400, { error: 'BAD_JSON' }); } }
      // A body that parses but is not a JSON object — null, an array, a bare
      // string or number — is refused here, before any route reads it: a null
      // failed on destructuring and came back as a 500.
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return send(400, { error: 'BAD_JSON' });
      }

      const authed = () =>
        (req.headers['x-admin-token'] || url.searchParams.get('token')) === ADMIN_TOKEN;

      try {
        // pages
        if (req.method === 'GET' && path === '/') return html(guestPage());
        if (req.method === 'GET' && path === '/host') return html(hostPage());
        if (req.method === 'GET' && path === '/admin') {
          if (!authed()) return send(401, { error: 'UNAUTHORIZED', hint: 'open /admin?token=<VIP_ADMIN_TOKEN>' });
          return html(adminPage(ADMIN_TOKEN));
        }

        // /v3 — the specification surface
        if (req.method === 'POST' && path === '/v3/precommit') return send(201, E.precommit(db, payload));
        if (req.method === 'POST' && path === '/v3/session/tick') {
          const r = E.tick(db, payload);
          return send(r.locked ? 423 : 200, r);   // 423 Locked: the stop is the product working
        }
        if (req.method === 'GET' && path === '/v3/policy/state') {
          return send(200, E.stateOf(db, url.searchParams.get('vip_id')));
        }
        if (req.method === 'POST' && path === '/v3/redirect/issue') return send(200, E.redirectIssue(db, payload));
        if (req.method === 'POST' && path === '/v3/programme/suppress') return send(200, E.programmeSuppress(db, payload));
        if (req.method === 'GET' && path.startsWith('/v3/audit/')) {
          let sid;
          try { sid = decodeURIComponent(path.slice('/v3/audit/'.length)); }
          catch { return send(400, { error: 'BAD_REQUEST' }); }   // not valid percent-encoding
          return send(200, E.audit(db, sid));
        }
        if (path.startsWith('/v3/')) return send(404, { error: 'NO_ROUTE', routes: SPEC_ROUTES });

        // /vip — the product surface of this running system
        if (req.method === 'GET' && path === '/vip/guests') return send(200, { guests: E.guests(db) });
        if (req.method === 'GET' && path === '/vip/sessions') {
          const rows = db.prepare("SELECT * FROM sessions WHERE state='live' ORDER BY opened_at ASC").all();
          const stopped = db.prepare("SELECT COUNT(*) n FROM sessions WHERE state='stopped'").get().n;
          return send(200, { live: rows.map(E.view), stopped_count: stopped });
        }
        if (req.method === 'POST' && path === '/vip/session/stop') return send(200, E.voluntaryStop(db, payload));
        if (req.method === 'GET' && path === '/vip/credits') {
          const v = url.searchParams.get('vip_id');
          const credits = db.prepare('SELECT * FROM credits WHERE guest_id = ? ORDER BY id ASC').all(v);
          const roll = db.prepare('SELECT COALESCE(SUM(amount_eur),0) v FROM rollover WHERE guest_id = ? AND applied_at IS NULL').get(v);
          return send(200, { vip_id: v, credits, rollover_eur: P.money(roll.v) });
        }
        if (req.method === 'POST' && path === '/vip/credit/redeem') return send(200, E.redeem(db, payload));
        if (req.method === 'POST' && path === '/vip/rollover/apply') return send(200, E.applyRollover(db, payload));
        if (req.method === 'GET' && path === '/vip/quarter') return send(200, E.quarter(db));
        if (req.method === 'GET' && path === '/vip/chain/verify') return send(200, B.verify(db));
        if (req.method === 'POST' && path === '/vip/guest/erase') {
          if (!authed()) return send(401, { error: 'UNAUTHORIZED' });
          return send(200, B.erase(db, payload.vip_id));
        }
        if (req.method === 'GET' && path === '/vip/config') {
          return send(200, {
            mode_default: P.CFG.mode, threshold: P.CFG.threshold, nudge: P.CFG.nudge,
            escalate: P.CFG.escalate, rollover: P.CFG.rollover, redirect_split: P.CFG.split,
            redirect_total: P.REDIRECT_TOTAL, residual_to_guest: P.RESIDUAL,
            eligibility_default: P.ELIGIBILITY_DEFAULT, reward_cap_eur: P.REWARD_CAP_EUR,
            eligibility_ttl_days: P.ELIGIBILITY_TTL_DAYS,
            downstream: B.downstream.armed() ? 'ARMED' : 'DORMANT',
            spec_routes: SPEC_ROUTES
          });
        }
        return send(404, { error: 'NO_ROUTE', spec_routes: SPEC_ROUTES });
      } catch (err) {
        return send(err.status || 500, { error: err.message });
      }
    });
  });
}

module.exports = { createServer, ADMIN_TOKEN, SPEC_ROUTES };
