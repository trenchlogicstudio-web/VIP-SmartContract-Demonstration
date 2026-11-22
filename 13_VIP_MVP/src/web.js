// VIP SmartContract · MVP v0.2.17 · web layer
// Copyright (c) 2026 Miloš Petrović (Trench Logic Studio) · SPDX-License-Identifier: MIT
//
// Two surfaces, deliberately separated:
//   /v3/*   the architecture contract from 04_API_Spec.yaml. Nine routes, at
//           the paths, status codes and error identifiers of registry slot
//           04b_Integration_Reference.js. This is what an integrator implements in
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
const { readBody } = require('./request');
const { validVip } = require('./values');

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
                     'POST /v3/programme/suppress', 'POST /v3/session/authorize',
                     'POST /v3/session/release', 'GET /v3/terms'];

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
main{padding:22px;max-width:1040px;min-width:0}
a{color:var(--accent)}
#offer{margin:16px 0;padding:14px;border-left:3px solid var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@media(max-width:600px){main{padding:12px} .panel{overflow-wrap:anywhere} pre{white-space:pre-wrap} #state tr{display:grid;grid-template-columns:1fr 1fr} #state th,#state td{min-width:0} .panel input,.panel select{max-width:100%}}
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
<footer>MIT LICENSE · SYNTHETIC BY DECLARATION · seeded figures reproduce the canon reference preset and are
not a measurement of any operator · © 2026 Miloš Petrović · Trench Logic Studio</footer></body></html>`;
}
const NAV = '<a href="/">Guest</a><a href="/host">Host console</a><a href="/admin">Admin</a>';

// ── pages ─────────────────────────────────────────────────────────────────
function guestPage() {
  return page('Guest screen', NAV, `
<div class="panel"><h2>Review your budget</h2>
  <label>Guest ID <input id="vip" value="VIP-REVIEW" required></label>
  <label>Budget (€) <input id="budget" type="number" min="0.01" max="10000000" step="0.01" value="20000"></label>
  <label>Policy mode <select id="mode"><option value="hard_stop"${P.CFG.mode === 'hard_stop' ? ' selected' : ''}>Hard-Stop</option><option value="advisory"${P.CFG.mode === 'advisory' ? ' selected' : ''}>Advisory</option></select></label>
  <label><input id="determined" type="checkbox" checked> Simulate a current operator assessment permitting benefits</label>
  <button type="button" id="review" onclick="reviewQuote()">Review amounts</button>
  <section id="offer" hidden aria-labelledby="offerTitle">
    <h3 id="offerTitle">Your terms at the threshold</h3>
    <p id="terms"></p><p id="line"></p><p id="split"></p><p id="gate" class="note"></p>
    <button id="confirm" disabled onclick="pre()">I accept these amounts and rules</button>
    <button class="ghost" onclick="decline()">Decline</button>
  </section>
  <p id="notice" class="note" role="status" aria-live="polite">Review the amounts before confirming.</p>
</div>
<div class="panel"><h2>Live session</h2>
  <p class="note">In Hard-Stop the engine refuses a checked stake larger than what is left to the line. Advisory records checked stakes and permits continued play. A plain tick reports consumption after it happened: in hard_stop the session
  locks on the tick that crosses the line, and that tick counts in full. A platform that wants the line
  held runs every stake through the check.</p>
  <div id="meterwrap"></div>
  <button class="requires-live" disabled onclick="checked(500)">Check, then report 500</button>
  <button class="requires-live" disabled onclick="checked(1500)">Check, then report 1500</button>
  <button class="ghost requires-live" disabled onclick="tick(500)">Report only +500</button>
  <button class="ghost requires-live" disabled onclick="tick(1500)">Report only +1500</button>
  <button class="stop requires-live" disabled onclick="vstop()">Stop now, voluntarily</button>
  <button id="issue" hidden onclick="issue()">Issue settled credits</button>
  <button class="ghost" onclick="load()">Refresh state</button>
  <div id="state"></div>
  <section id="receiptPanel" hidden><h3>Session receipt</h3><p id="acceptedLine"></p><p id="settledLine"></p>
  <a id="receipt">View the full receipt as JSON</a></section>
</div>
<div class="panel"><h2>Response</h2><pre id="out">—</pre></div>
<script>
${ESC}
const $=s=>document.querySelector(s);
const show=o=>{$('#out').textContent=JSON.stringify(o,null,2)};
async function call(m,u,b){const r=await fetch(u,{method:m,headers:{'content-type':'application/json'},
  body:b?JSON.stringify(b):undefined});const j=await r.json();show({status:r.status,body:j});return j}
let review = null, reviewNumber = 0, busy = false;
const euros = n => new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR'}).format(n);
function invalidate(message) {
  reviewNumber++;
  review = null;
  $('#offer').hidden = true;
  $('#confirm').disabled = true;
  $('#notice').textContent = message || 'Review the current amounts before confirming.';
}
function decline() { invalidate('Declined. No new policy was armed.'); }
function inputs() {
  return {vip_id:$('#vip').value, budget_eur:Number($('#budget').value), mode:$('#mode').value};
}
async function reviewQuote() {
  if (busy) return;
  invalidate('Loading your terms…');
  const number = reviewNumber, body = inputs();
  body.eligibility = $('#determined').checked ? 'permitted' : 'suppressed';
  if ($('#determined').checked) body.eligibility_at = new Date(Date.now()-60000).toISOString();
  try {
    const res = await fetch('/vip/quote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const q = await res.json();
    if (number !== reviewNumber) return;
    if (!res.ok) { invalidate('Review unavailable · '+q.error); return; }
    review = { body, quote:q };
    const t=q.terms, a=q.at_line;
    $('#terms').textContent='Terms '+q.terms_version+' · budget '+euros(q.budget_eur)+' · commitment '+t.commitment_hours+' h from arming.';
    $('#line').textContent=q.mode==='hard_stop'
      ? 'Hard-Stop locks play at '+euros(q.armed_at_eur)+' consumed when each stake is checked first. A reported-only stake can cross the line.'
      : 'Advisory alerts the host at '+euros(q.armed_at_eur)+' consumed. Play stays open. You can stop voluntarily.';
    $('#split').textContent='If you stop on that line, '+euros(a.preserved)+' remains. Resort credit '+euros(a.redirect)+' (spa '+euros(a.credits.spa)+', dining '+euros(a.credits.fnb)+', retail '+euros(a.credits.retail)+'). Future-play credit '+euros(a.rollover)+'. Your own balance '+euros(a.residual)+'.';
    $('#gate').textContent=(a.eligibility==='suppressed'?'Benefits withheld. ':'Benefits permitted by the simulated assessment. ')+
      (t.reward_cap_eur===null?'No configured benefit ceiling. ':'Combined benefit ceiling '+euros(t.reward_cap_eur)+' per stop. ')+
      (t.eligibility_ttl_days===null?'The assessment has no configured expiry. ':'Assessment lifetime '+t.eligibility_ttl_days+' days. ')+
      'A later restriction or withdrawal can reduce benefits and increase your balance. The operator handles payment.';
    $('#offer').hidden=false; $('#confirm').disabled=false;
    $('#notice').textContent='Confirm to arm this budget, or decline.';
  } catch { if (number===reviewNumber) invalidate('Review unavailable. Try again.'); }
}
async function pre() {
  if (!review || busy) return;
  const accepted=review, q=accepted.quote;
  busy=true;
  invalidate('Submitting your confirmation…');
  try {
    const result=await call('POST','/vip/confirm',{...accepted.body,terms_version:q.terms_version,quote_id:q.quote_id,review_id:q.review_id});
    $('#notice').textContent=result.session_id && !result.error ? 'Policy armed. Your session receipt is available below.'
      : 'Policy was not armed · '+result.error+'. Review the current amounts.';
    await load();
  } catch { $('#notice').textContent='Confirmation status unavailable. Refresh the session before retrying.'; }
  finally { busy=false; }
}
for (const id of ['#vip','#budget','#mode','#determined']) {
  $(id).addEventListener('input',()=>invalidate());
  $(id).addEventListener('change',()=>invalidate());
}
let currentSession = null, requestNumber = 0;
function sessionAction(path, extra) {
  if (!currentSession) return;
  return call('POST',path,{vip_id:$('#vip').value,session_id:currentSession,...extra}).then(load);
}
const eventId=()=>Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
function tick(d){return sessionAction('/v3/session/tick',{delta_eur:d,event_id:eventId()})}
// The wager path a platform should run: ask first, place only what was allowed,
// then report it against the check it was allowed under.
async function checked(d){
  if (!currentSession) return;
  const vip=$('#vip').value, session=currentSession;
  const a=await call('POST','/v3/session/authorize',{vip_id:vip,session_id:session,stake_eur:d});
  if(a.authorized){
    const t=await call('POST','/v3/session/tick',{vip_id:vip,session_id:session,delta_eur:d,authorization_id:a.authorization_id,event_id:eventId()});
    show({authorize:a,tick:t});
  }
  return load();
}
function vstop(){return sessionAction('/vip/session/stop',{})}
function issue(){return sessionAction('/v3/redirect/issue',{})}
async function load(){
  const number=++requestNumber, vip=$('#vip').value;
  currentSession=null;
  document.querySelectorAll('.requires-live').forEach(b=>b.disabled=true);
  $('#issue').hidden=true; $('#receiptPanel').hidden=true;
  const r=await fetch('/v3/policy/state?vip_id='+encodeURIComponent(vip));
  const s=await r.json();
  if(number!==requestNumber || vip!==$('#vip').value)return;
  if(!r.ok){$('#state').innerHTML='<p class="note">'+esc(s.error||'no session')+'</p>';$('#meterwrap').innerHTML='';return}
  currentSession=s.session_id;
  $('#receipt').href='/vip/session/receipt?vip_id='+encodeURIComponent(vip)+'&session_id='+encodeURIComponent(s.session_id);

  document.querySelectorAll('.requires-live').forEach(b=>b.disabled=s.stopped);
  $('#issue').hidden=!s.stopped || s.redirect_issued || s.eligibility!=='permitted';
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
    '<tr><th>Reserved by checked stakes</th><td class="num">'+s.reserved_eur.toFixed(2)+'</td>'+
    '<th>'+(s.mode==='advisory'?'Room to advisory line':'Largest stake allowed now')+'</th><td class="num">'+s.headroom_eur.toFixed(2)+'</td></tr>'+
    '<tr><th>'+(s.stopped?'Settled resort credit':'Resort credit if you stop')+'</th><td class="num">'+s.incentive_preview.redirect_eur.toFixed(2)+' resort credit</td>'+
    '<th>plus rollover</th><td class="num">'+s.incentive_preview.rollover_eur.toFixed(2)+'</td></tr>'+
    '<tr><th>returned to you</th><td class="num">'+s.incentive_preview.residual_to_guest_eur.toFixed(2)+'</td>'+
    '<th></th><td class="note">the residual is the guest\\'s own money</td></tr></table>';
  const response=await fetch($('#receipt').href);
  if (!response.ok) return;
  const rec=await response.json();
  if (number!==requestNumber || vip!==$('#vip').value) return;
  const agreement=rec.agreement;
  const provenance={quote_confirmed:'Confirmed after review',version_supplied:'Terms version supplied by API',configured_only:'Configured on the API call'};
  $('#acceptedLine').textContent=agreement ? provenance[agreement.confirmation]+' · '+agreement.mode+' · '+agreement.terms_version+
    '. At the line, resort '+euros(agreement.at_line.redirect)+', future play '+euros(agreement.at_line.rollover)+', guest '+euros(agreement.at_line.residual)+'.'
    : 'Legacy session. The original quote was not recorded.';
  const last=rec.events.filter(e=>e.policy).at(-1);
  const reasons={agreed_terms:'Agreed rules applied',original_and_current_limits:'Both the agreed rules and the current restrictions were applied',
    legacy_terms_unavailable:'Original rules unavailable',determination_expired_or_missing:'Assessment expired or missing',incentives_withheld:'Benefits withheld'};
  $('#settledLine').textContent=last ? 'Recorded decision · '+(reasons[last.policy.reason]||last.policy.reason)+
    '. Current terms '+last.policy.current_version+(last.policy.current_terms && last.policy.current_terms.reward_cap_eur!==null?' · benefit ceiling '+euros(last.policy.current_terms.reward_cap_eur):'')+'. Guest balance '+euros(last.residual_to_guest_eur??last.returned_to_guest_eur)+'.'
    : 'The final allocation will appear here when the session stops.';
  $('#receiptPanel').hidden=false;

}
$('#vip').addEventListener('input',load);
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
      '<td><button data-stop="'+esc(s.vip_id)+'" data-session="'+esc(s.session_id)+'">Guest stops</button></td></tr>').join('')+'</table>';
}
$('#live').addEventListener('click',e=>{const b=e.target.closest('button[data-stop]');if(b)stop(b.dataset.stop,b.dataset.session)});
function stop(v,s){call('POST','/vip/session/stop',{vip_id:v,session_id:s}).then(live)}
async function credits(){
  const v=$('#vip').value;const r=await fetch('/vip/credits?vip_id='+encodeURIComponent(v));const j=await r.json();
  if(!r.ok){$('#credits').innerHTML='<p class="note">'+esc(j.error||'none')+'</p>';return}
  $('#credits').innerHTML=j.pending_sessions.map(id=>'<button data-issue="'+esc(id)+'" data-vip="'+esc(v)+'">Issue session '+esc(id.slice(0,8))+'</button>').join('')+'<table><tr><th>#</th><th>Category</th><th class="num">Amount</th><th>State</th><th></th></tr>'+
    j.credits.map(c=>'<tr><td>'+esc(c.id)+'</td><td>'+esc(c.category)+'</td><td class="num">'+c.amount_eur.toFixed(2)+'</td>'+
      '<td>'+(c.redeemed_at?'<span class="tag">redeemed</span>':'<span class="tag live">issued</span>')+'</td>'+
      '<td>'+(c.redeemed_at?'':'<button data-redeem="'+esc(c.id)+'">Redeem</button>')+'</td></tr>').join('')+
    '</table><p class="note">Rollover held: '+j.rollover_eur.toFixed(2)+
    (j.rollover_eur>0?' <button class="ghost" data-roll="'+esc(v)+'">Apply rollover</button>':'')+'</p>';
}
$('#credits').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
  if(b.dataset.issue)call('POST','/v3/redirect/issue',{vip_id:b.dataset.vip,session_id:b.dataset.issue}).then(credits);
  if(b.dataset.redeem)redeem(Number(b.dataset.redeem));if(b.dataset.roll!==undefined)roll(b.dataset.roll)});
function redeem(id){call('POST','/vip/credit/redeem',{credit_id:id}).then(credits)}
function roll(v){call('POST','/vip/rollover/apply',{vip_id:v}).then(credits)}
live();
</script>`);
}

function adminPage(token) {
  return page('Admin', NAV, `
<div class="panel"><h2>Synthetic reference quarter</h2>
  <p class="note">Credit totals below cover the 60 seeded sessions. New demo sessions are outside this cohort.
  The seeded quarter reproduces the canon reference preset; it is synthetic by declaration.</p>
  <div id="q" class="grid"></div><div id="qd"></div></div>
<div class="panel"><h2>Canon comparison figures</h2>
  <p class="note">These are ANCHORED assumptions and one EMPIRICAL figure carried from the canon. They are
  not produced by this build and must never be read as its output.</p>
  <table>
   <tr><th>Retention under incentive</th><td class="num">0.84</td><td class="note">ANCHORED — share of limited VIPs retained over the quarter, band 0.61–0.92</td></tr>
   <tr><th>Retention, hard stop only</th><td class="num">0.61</td><td class="note">share of limited VIPs retained over the quarter without the incentive layer — the fixed baseline</td></tr>
   <tr><th>Post-stop churn</th><td class="num">0.39 &rarr; 0.16</td><td class="note">ANCHORED — share of stopped players lost within the quarter, without and then with the incentive layer</td></tr>
   <tr><th>Host hours index</th><td class="num">38</td><td class="note">ANCHORED — indexed against the operator's own baseline of 100</td></tr>
   <tr><th>Limit-setter odds ratio</th><td class="num">2.92</td><td class="note">EMPIRICAL — odds of limit-setters remaining active at one year, in an observational study of voluntary limit-setting. <a href="https://doi.org/10.1007/s11469-019-00084-3">Auer, Hopfgartner and Griffiths, Table 5</a></td></tr>
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
history.replaceState(null,'','/admin');
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
    ['Resort credit allocated',j.redirected_eur.toLocaleString()+' EUR'],
    ['Rollover allocated at stop',j.rollover_allocated_eur.toLocaleString()+' EUR'],
    ['Rollover still outstanding',j.rollover_liability_eur.toLocaleString()+' EUR'],
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
    readBody(req, res, body => {
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      const html = s => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' }); res.end(s); };

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
          if (!authed() && (req.headers.accept || '').includes('text/html')) {
            return html(page('Admin sign-in', NAV, `<form method="get" action="/admin" class="panel">
              <label>Admin token <input name="token" type="password" required autocomplete="off"></label>
              <button>Open admin</button></form>`));
          }
          if (!authed()) return send(401, { error: 'UNAUTHORIZED', hint: 'open /admin?token=<VIP_ADMIN_TOKEN>' });
          return html(adminPage(ADMIN_TOKEN));
        }

        // /v3 — the specification surface
        if (req.method === 'GET' && path === '/v3/terms') return send(200, E.terms());
        if (req.method === 'POST' && path === '/v3/precommit') return send(201, E.precommit(db, payload));
        if (req.method === 'POST' && path === '/v3/session/tick') {
          const r = E.tick(db, payload);
          return send(r.locked ? 423 : 200, r);   // 423 Locked: the stop is the product working
        }
        if (req.method === 'GET' && path === '/v3/policy/state') {
          return send(200, E.stateOf(db, url.searchParams.get('vip_id')));
        }
        if (req.method === 'POST' && path === '/v3/session/authorize') return send(200, E.authorize(db, payload));
        if (req.method === 'POST' && path === '/v3/session/release') return send(200, E.release(db, payload));
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
        if (req.method === 'POST' && path === '/vip/quote') return send(200, E.quote(db, payload));
        if (req.method === 'POST' && path === '/vip/confirm') return send(201, E.confirm(db, payload));
        if (req.method === 'GET' && path === '/vip/session/receipt') return send(200, E.receipt(db, url.searchParams.get('vip_id'), url.searchParams.get('session_id') ?? undefined));
        if (req.method === 'GET' && path === '/vip/guests') return send(200, { guests: E.guests(db) });
        if (req.method === 'GET' && path === '/vip/sessions') {
          const rows = db.prepare("SELECT * FROM sessions WHERE state='live' ORDER BY opened_at ASC").all();
          const stopped = db.prepare("SELECT COUNT(*) n FROM sessions WHERE state='stopped'").get().n;
          return send(200, { live: rows.map(E.view), stopped_count: stopped });
        }
        if (req.method === 'POST' && path === '/vip/session/stop') return send(200, E.voluntaryStop(db, payload));
        if (req.method === 'GET' && path === '/vip/credits') {
          const v = url.searchParams.get('vip_id');
          if (!validVip(v)) return send(200, { vip_id: v, credits: [], rollover_eur: 0, pending_sessions: [] });
          const pending = db.prepare("SELECT id, eligibility, eligibility_at FROM sessions WHERE guest_id=? AND state='stopped' AND redirect_issued=0 ORDER BY rowid").all(v)
            .filter(s => P.effectiveEligibility(s.eligibility, s.eligibility_at) === 'permitted').map(s => s.id);
          const credits = db.prepare('SELECT c.* FROM credits c JOIN sessions s ON s.id=c.session_id WHERE c.guest_id=? AND s.redirect_issued=1 ORDER BY c.id').all(v);
          const roll = db.prepare('SELECT COALESCE(SUM(r.amount_eur),0) v FROM rollover r JOIN sessions s ON s.id=r.session_id WHERE r.guest_id=? AND r.applied_at IS NULL AND s.redirect_issued=1').get(v);
          return send(200, { vip_id: v, credits, rollover_eur: P.money(roll.v), pending_sessions: pending });
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
            mode_default: P.CFG.mode, threshold: P.W.threshold / P.MICRO, nudge: P.W.nudge / P.MICRO,
            escalate: P.W.escalate / P.MICRO, rollover: P.W.rollover / P.MICRO,
            redirect_split: { spa: P.W.spa / P.MICRO, fnb: P.W.fnb / P.MICRO, retail: P.W.retail / P.MICRO },
            redirect_total: P.REDIRECT_TOTAL, residual_to_guest: P.RESIDUAL,
            eligibility_default: P.ELIGIBILITY_DEFAULT, reward_cap_eur: P.REWARD_CAP_EUR,
            eligibility_ttl_days: P.ELIGIBILITY_TTL_DAYS,
            downstream: B.downstream.armed() ? 'ARMED' : 'DORMANT',
            commitment_hours: P.COMMITMENT_HOURS,
            terms_version: P.TERMS_VERSION,
            spec_routes: SPEC_ROUTES
          });
        }
        return send(404, { error: 'NO_ROUTE', spec_routes: SPEC_ROUTES });
      } catch (err) {
        return send(err.status || 500, Object.assign({ error: err.status ? err.message : 'INTERNAL_ERROR' }, err.status ? err.extra || {} : {}));
      }
    });
  });
}

module.exports = { createServer, ADMIN_TOKEN, SPEC_ROUTES };
