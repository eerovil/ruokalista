import baseWorker from "./index";
import { authConfigured, clearSessionCookie, finishGoogleAuth, readSessionMember, startGoogleAuth, type AuthMember } from "./auth";
import { listIngredientChoices, saveCorrectedDraft, structureRecipe, validateCorrectedDraft } from "./intake";

interface Env {
  DB: D1Database;
  DEV_MEMBER_ID?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
}

type MemberRow = AuthMember;

async function resolveDevMember(env: Env): Promise<MemberRow | null> {
  // Local-development bypass only: once Google sign-in is configured, a stray
  // DEV_MEMBER_ID must not open the app to anyone with the URL.
  if (authConfigured(env)) return null;
  if (!env.DEV_MEMBER_ID || !/^\d+$/.test(env.DEV_MEMBER_ID)) return null;
  return env.DB.prepare(`SELECT id, household_id, display_name FROM member WHERE id = ?`)
    .bind(Number(env.DEV_MEMBER_ID)).first<MemberRow>();
}

async function resolveMember(request: Request, env: Env): Promise<MemberRow | null> {
  return await readSessionMember(request, env) ?? await resolveDevMember(env);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function jsonScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function signInPage(env: Env): Response {
  const action = authConfigured(env)
    ? `<a class="button" href="/auth/google">Kirjaudu Googlella</a>`
    : `<p>Google-kirjautumisen asetuksia ei ole vielä määritetty.</p>`;
  return new Response(`<!doctype html><html lang="fi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kirjaudu · Ruokalista</title><style>:root{font-family:system-ui,sans-serif;background:#f6f6f2;color:#1d1d1f}main{width:min(32rem,100%);margin:auto;padding:2rem 1rem}.card{background:white;border:1px solid #deded7;border-radius:.8rem;padding:1.2rem}.button{display:inline-block;padding:.7rem 1rem;border:1px solid #c9c9c2;border-radius:.6rem;background:#efefe9;color:inherit;text-decoration:none}</style></head><body><main><h1>Ruokalista</h1><div class="card"><p>Kirjaudu kotitalouden Google-tilillä.</p>${action}</div></main></body></html>`, { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function intakePage(member: MemberRow, ingredients: Array<{ id: number; name: string }>): Response {
  const page = `<!doctype html>
<html lang="fi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lisää resepti · Ruokalista</title>
<style>
:root{font-family:system-ui,sans-serif;color:#1d1d1f;background:#f6f6f2}*{box-sizing:border-box}body{margin:0}main{width:min(48rem,100%);margin:auto;padding:1rem}a{color:inherit}.nav{display:flex;gap:.8rem;flex-wrap:wrap;margin-bottom:1rem}.card,.line,.step{background:white;border:1px solid #deded7;border-radius:.8rem;padding:1rem;margin:.75rem 0}.stack{display:flex;flex-direction:column;gap:.65rem}textarea,input,select,button{font:inherit}textarea,input,select{width:100%;padding:.65rem;border:1px solid #c9c9c2;border-radius:.55rem;background:white}textarea{min-height:10rem}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem}.row-actions{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.55rem}button{padding:.6rem .8rem;border:1px solid #c9c9c2;border-radius:.55rem;background:#efefe9}.primary{font-weight:700}.muted{color:#666}.hidden{display:none}@media(max-width:34rem){.grid{grid-template-columns:1fr}}
</style></head><body><main>
<h1>Ruokalista</h1><div class="nav"><a href="/">Viikko</a><a href="/recipes">Reseptit</a><a href="/intake">Lisää resepti</a><a href="/ingredients">Ainekset</a><a href="/settings">Asetukset</a><form method="post" action="/auth/signout" style="margin:0"><button type="submit">Kirjaudu ulos</button></form></div>
<h2>Lisää resepti</h2><p class="muted">Kirjautuneena: ${escapeHtml(member.display_name)}</p>
<section class="card" id="source-card"><div class="stack">
<label>Liitä reseptin teksti<textarea id="source-text" placeholder="Liitä resepti tähän"></textarea></label>
<button id="structure-text" class="primary" type="button">Jäsennä teksti</button>
<hr>
<label>tai kuvaa painettu resepti<input id="source-image" type="file" accept="image/*" capture="environment"></label>
<button id="structure-image" type="button">Jäsennä kuva</button>
<div id="status" class="muted"></div></div></section>
<section id="draft" class="hidden"><h2>Tarkista ja korjaa</h2>
<div class="card stack"><label>Nimi<input id="title" type="text"></label><label>Reseptin annosmäärä (tyhjä = ei tiedossa)<input id="yield" type="number" min="1" step="1"></label></div>
<h3>Ainesrivit</h3><div id="lines"></div><button id="add-line" type="button">+ Lisää ainesrivi</button>
<h3>Työvaiheet</h3><div id="steps"></div><button id="add-step" type="button">+ Lisää työvaihe</button>
<div class="card"><strong>Lähdeteksti</strong><pre id="source-preview" style="white-space:pre-wrap"></pre></div>
<button id="save" class="primary" type="button">Tallenna resepti</button><div id="save-status"></div></section>
<script>const INGREDIENTS=${jsonScript(ingredients)};
let state=null;
const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
function setStatus(text,error=false){const el=document.getElementById('status');el.textContent=text;el.style.color=error?'#a00':''}
function ingredientOptions(selected){return '<option value="new">Uusi aines</option>'+INGREDIENTS.map(i=>'<option value="'+i.id+'" '+(selected===i.id?'selected':'')+'>'+esc(i.name)+'</option>').join('')}
function render(){if(!state)return;document.getElementById('draft').classList.remove('hidden');document.getElementById('title').value=state.draft.title;document.getElementById('yield').value=state.draft.yield_portions??'';document.getElementById('source-preview').textContent=state.draft.source_text;
 document.getElementById('lines').innerHTML=state.draft.lines.map((l,i)=>'<div class="line" data-line="'+i+'"><div class="grid"><label>Määrä<input data-f="quantity" type="number" step="any" value="'+(l.quantity??'')+'"></label><label>Vaihteluvälin loppu<input data-f="quantity_max" type="number" step="any" value="'+(l.quantity_max??'')+'"></label><label>Yksikkö<input data-f="unit" value="'+esc(l.unit??'')+'"></label><label>Toinen määrä<input data-f="alt_quantity" type="number" step="any" value="'+(l.alt_quantity??'')+'"></label><label>Toinen yksikkö<input data-f="alt_unit" value="'+esc(l.alt_unit??'')+'"></label><label>Aines<select data-f="ingredient_id">'+ingredientOptions(l.ingredient_id)+'</select></label></div><label>Uuden aineksen nimi / ehdotus<input data-f="ingredient_name" value="'+esc(l.ingredient_name)+'"></label><label>Lähderivi<input data-f="source_line" value="'+esc(l.source_line)+'"></label><div class="row-actions"><button data-action="line-up">↑</button><button data-action="line-down">↓</button><button data-action="line-delete">Poista rivi</button></div></div>').join('');
 document.getElementById('steps').innerHTML=state.draft.steps.map((s,i)=>'<div class="step" data-step="'+i+'"><textarea>'+esc(s)+'</textarea><div class="row-actions"><button data-action="step-up">↑</button><button data-action="step-down">↓</button><button data-action="step-delete">Poista</button></div></div>').join('');}
function sync(){if(!state)return;state.draft.title=document.getElementById('title').value;const y=document.getElementById('yield').value;state.draft.yield_portions=y===''?null:Number(y);document.querySelectorAll('[data-line]').forEach(el=>{const l=state.draft.lines[Number(el.dataset.line)];el.querySelectorAll('[data-f]').forEach(inp=>{const f=inp.dataset.f;let v=inp.value;if(['quantity','quantity_max','alt_quantity'].includes(f))v=v===''?null:Number(v);if(f==='ingredient_id')v=v==='new'?null:Number(v);if(['unit','alt_unit'].includes(f))v=v===''?null:v;l[f]=v})});document.querySelectorAll('[data-step]').forEach(el=>state.draft.steps[Number(el.dataset.step)]=el.querySelector('textarea').value)}
async function downscale(file){const bitmap=await createImageBitmap(file);const max=1500,scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);return await new Promise(r=>canvas.toBlob(r,'image/jpeg',.86))}
async function structure(route){try{setStatus('Jäsennetään…');const fd=new FormData();fd.set('source_route',route);if(route==='pasted'){const text=document.getElementById('source-text').value;if(!text.trim())throw new Error('Liitä ensin reseptin teksti.');fd.set('source_text',text)}else{const file=document.getElementById('source-image').files[0];if(!file)throw new Error('Valitse tai ota ensin kuva.');fd.set('image',await downscale(file),'recipe.jpg')}
 const res=await fetch('/api/intake/structure',{method:'POST',body:fd});const data=await res.json();if(!res.ok)throw new Error(data.error||'Jäsentäminen epäonnistui.');state={draft:data.draft,source_route:route,structured_by:data.model};render();setStatus('Luonnos valmis. Tarkista kaikki kentät ennen tallennusta.')}catch(e){setStatus(e.message,true)}}
document.getElementById('structure-text').onclick=()=>structure('pasted');document.getElementById('structure-image').onclick=()=>structure('photographed');document.getElementById('add-line').onclick=()=>{sync();state.draft.lines.push({quantity:null,quantity_max:null,unit:null,alt_quantity:null,alt_unit:null,ingredient_id:null,ingredient_name:'',source_line:''});render()};document.getElementById('add-step').onclick=()=>{sync();state.draft.steps.push('');render()};document.getElementById('draft').addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b)return;e.preventDefault();sync();const le=b.closest('[data-line]'),se=b.closest('[data-step]');if(le){const i=Number(le.dataset.line);if(b.dataset.action==='line-delete')state.draft.lines.splice(i,1);if(b.dataset.action==='line-up'&&i>0)[state.draft.lines[i-1],state.draft.lines[i]]=[state.draft.lines[i],state.draft.lines[i-1]];if(b.dataset.action==='line-down'&&i<state.draft.lines.length-1)[state.draft.lines[i+1],state.draft.lines[i]]=[state.draft.lines[i],state.draft.lines[i+1]]}if(se){const i=Number(se.dataset.step);if(b.dataset.action==='step-delete')state.draft.steps.splice(i,1);if(b.dataset.action==='step-up'&&i>0)[state.draft.steps[i-1],state.draft.steps[i]]=[state.draft.steps[i],state.draft.steps[i-1]];if(b.dataset.action==='step-down'&&i<state.draft.steps.length-1)[state.draft.steps[i+1],state.draft.steps[i]]=[state.draft.steps[i],state.draft.steps[i+1]]}render()});
document.getElementById('save').onclick=async()=>{const out=document.getElementById('save-status');try{sync();out.textContent='Tallennetaan…';const payload={...state.draft,source_route:state.source_route,structured_by:state.structured_by};const res=await fetch('/api/recipes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const data=await res.json();if(!res.ok)throw new Error(data.error||'Tallennus epäonnistui.');location.href='/recipes/'+data.id}catch(e){out.textContent=e.message;out.style.color='#a00'}};</script>
</main></body></html>`;
  return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function handleStructure(request: Request, env: Env, member: MemberRow): Promise<Response> {
  try {
    const form = await request.formData();
    const route = String(form.get("source_route") ?? "");
    if (route !== "pasted" && route !== "photographed") return Response.json({ error: "Lähdereitti ei kelpaa." }, { status: 400 });
    let sourceText: string | null = null;
    let image: { mediaType: string; data: string } | null = null;
    if (route === "pasted") {
      sourceText = String(form.get("source_text") ?? "");
      if (!sourceText.trim()) return Response.json({ error: "Lähdeteksti puuttuu." }, { status: 400 });
    } else {
      const value = form.get("image");
      if (!(value instanceof File) || value.size === 0) return Response.json({ error: "Kuva puuttuu." }, { status: 400 });
      if (!value.type.startsWith("image/")) return Response.json({ error: "Tiedosto ei ole kuva." }, { status: 400 });
      image = { mediaType: value.type || "image/jpeg", data: bytesToBase64(await value.arrayBuffer()) };
    }
    const result = await structureRecipe(env, env.DB, member.household_id, route, sourceText, image);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Jäsentäminen epäonnistui." }, { status: 502 });
  }
}

async function handleSave(request: Request, env: Env, member: MemberRow): Promise<Response> {
  try {
    const payload = validateCorrectedDraft(await request.json());
    const id = await saveCorrectedDraft(env.DB, member.household_id, member.id, payload);
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Tallennus epäonnistui." }, { status: 400 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return baseWorker.fetch(request, env);
    if (request.method === "GET" && url.pathname === "/auth/google") return startGoogleAuth(request, env);
    if (request.method === "GET" && url.pathname === "/auth/google/callback") return finishGoogleAuth(request, env);
    if (request.method === "POST" && url.pathname === "/auth/signout") {
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": clearSessionCookie() } });
    }

    const member = await resolveMember(request, env);
    if (!member) return signInPage(env);

    if (url.pathname === "/intake" || url.pathname === "/api/intake/structure" || (url.pathname === "/api/recipes" && request.method === "POST")) {
      if (request.method === "GET" && url.pathname === "/intake") return intakePage(member, await listIngredientChoices(env.DB, member.household_id));
      if (request.method === "POST" && url.pathname === "/api/intake/structure") return handleStructure(request, env, member);
      if (request.method === "POST" && url.pathname === "/api/recipes") return handleSave(request, env, member);
    }

    const delegatedEnv: Env = { ...env, DEV_MEMBER_ID: String(member.id) };
    return baseWorker.fetch(request, delegatedEnv);
  }
} satisfies ExportedHandler<Env>;
