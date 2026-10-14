/**
 * PROTOTYPE (#350) — throwaway. Three versions of the add-recipe screen,
 * switched with `/intake?variant=A|B|C`. Nothing here starts an import or
 * saves a recipe: every submit is stubbed and only says what it would do.
 * Lives on the prototype/issue-350-intake branch; never merge it.
 */
import { html, raw, type Raw } from "./html.ts";

export const PROTOTYPE_VARIANTS = ["A", "B", "C"] as const;
export type PrototypeVariant = (typeof PROTOTYPE_VARIANTS)[number];

const NAMES: Record<PrototypeVariant, string> = {
  A: "Iso laatikko",
  B: "Yksi rivi, nimi käy",
  C: "Viestikenttä alhaalla",
};

export function readVariant(value: string | null): PrototypeVariant | null {
  return PROTOTYPE_VARIANTS.find((variant) => variant === value) ?? null;
}

const CAMERA = raw(`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`);
const PICTURES = raw(`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>`);
const SEND = raw(`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`);

const STYLE = `
  .proto-switch {
    position: fixed; top: calc(.4rem + env(safe-area-inset-top)); left: 50%;
    transform: translateX(-50%); z-index: 50;
    display: flex; align-items: center; gap: .25rem;
    padding: .2rem; border-radius: 2rem;
    background: #222; color: #fff; font-size: .8rem;
    box-shadow: 0 .3rem 1rem rgba(0,0,0,.35);
  }
  .proto-switch a { color: #fff; text-decoration: none; padding: .35rem .7rem;
    border-radius: 2rem; }
  .proto-switch a.on { background: #fff; color: #222; font-weight: 700; }
  #proto-a, #proto-b, #a-name { display: block; }
  #a-name > * { display: block; width: 100%; margin-bottom: .5rem; }
  .proto-switch span { white-space: nowrap; }
  .proto-result {
    margin: 1rem 0; padding: .75rem 1rem; border-radius: var(--radius);
    background: #fff4c2; color: #3b3000; border: 1px dashed #b39500;
    font-size: .9rem;
  }
  .proto-detect { min-height: 1.4rem; margin: .35rem 0 .75rem; font-size: .85rem;
    color: var(--muted); }
  .proto-detect strong { color: var(--accent); }
  .proto-pick { display: flex; gap: .5rem; margin: 0 0 1rem; }
  .proto-pick label {
    flex: 1; display: flex; align-items: center; justify-content: center; gap: .5rem;
    min-height: 3.25rem; border: 1px solid var(--edge); border-radius: var(--radius);
    background: var(--surface); font-weight: 600; cursor: pointer;
  }
  .proto-pick input, .proto-file { position: absolute; width: 1px; height: 1px;
    opacity: 0; pointer-events: none; }
  .proto-pages { margin: -.5rem 0 1rem; font-size: .9rem; }
  .proto-pages li { padding: .35rem 0; border-bottom: 1px solid var(--edge);
    display: flex; justify-content: space-between; gap: .5rem; }
  .proto-pages button { min-height: 1.8rem; padding: 0 .6rem; font-size: .8rem; }
  .proto-wide { width: 100%; }
  .proto-small { display: block; margin: 1.5rem 0 0; text-align: center;
    color: var(--muted); font-size: .9rem; }
  .proto-small button { background: none; border: 0; min-height: 0; padding: 0;
    color: var(--accent); text-decoration: underline; font-size: inherit; }
  .proto-box { width: 100%; font: inherit; padding: .75rem; resize: vertical;
    border: 1px solid var(--edge); border-radius: var(--radius);
    background: var(--bg); color: var(--fg); }
  .proto-or { display: flex; align-items: center; gap: .75rem; margin: 1.5rem 0 1rem;
    color: var(--muted); font-size: .85rem; }
  .proto-or::before, .proto-or::after { content: ""; flex: 1; border-top: 1px solid var(--edge); }
  .proto-tile {
    display: flex; align-items: center; gap: .9rem; padding: 1rem;
    border: 1px solid var(--edge); border-radius: var(--radius);
    background: var(--surface); cursor: pointer; margin-bottom: .5rem;
  }
  .proto-tile strong { display: block; }
  .proto-tile span { color: var(--muted); font-size: .85rem; }
  .proto-buttons { display: flex; flex-direction: column; gap: .5rem; }
  .proto-ghost { background: transparent; }
  .proto-hint li { display: flex; gap: .75rem; padding: .6rem 0;
    border-bottom: 1px solid var(--edge); }
  .proto-hint li span:first-child { color: var(--accent); }
  .proto-composer {
    position: fixed; left: 0; right: 0; z-index: 3;
    bottom: calc(var(--tabs-height) + env(safe-area-inset-bottom));
    background: var(--bg); border-top: 1px solid var(--edge);
    padding: .5rem .75rem;
  }
  .proto-composer-inner { max-width: 40rem; margin: 0 auto; }
  .proto-composer-row { display: flex; align-items: flex-end; gap: .4rem; }
  .proto-composer textarea { flex: 1; resize: none; max-height: 9rem;
    border-radius: 1.25rem; padding: .6rem .9rem; font: inherit; line-height: 1.35;
    border: 1px solid var(--edge); background: var(--surface); color: var(--fg); }
  .proto-round { width: var(--tap); height: var(--tap); padding: 0; border-radius: 50%;
    flex: none; }
  .proto-round.primary { color: var(--accent-fg); background: var(--accent);
    border-color: var(--accent); }
  .proto-round[disabled] { opacity: .4; }
  .proto-composer .proto-detect { margin: 0 0 .35rem .3rem; min-height: 0; }
  body.proto-c main { padding-bottom: calc(var(--tabs-height) + 9rem); }
`;

/**
 * Shared ES5 for all three: what the box holds, and the stubbed submit.
 * No regular expressions — this ships inside a template literal.
 */
const SCRIPT = `
(function () {
  function kind(value) {
    var t = (value || '').trim();
    if (t === '') return 'empty';
    var oneLine = t.indexOf('\\n') < 0;
    if (oneLine && t.indexOf(' ') < 0 && t.indexOf('.') > 0) return 'link';
    if (oneLine && t.length <= 60) return 'name';
    return 'text';
  }
  function host(value) {
    var t = value.trim();
    var at = t.indexOf('://');
    if (at >= 0) t = t.slice(at + 3);
    var slash = t.indexOf('/');
    if (slash >= 0) t = t.slice(0, slash);
    if (t.indexOf('www.') === 0) t = t.slice(4);
    return t;
  }
  function lines(value) { return value.trim().split('\\n').length; }
  window.protoKind = kind;
  window.protoHost = host;
  window.protoLines = lines;
  window.protoSay = function (message) {
    var box = document.getElementById('proto-result');
    box.textContent = 'Prototyyppi: ' + message;
    box.hidden = false;
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  window.protoPages = [];
  window.protoAddPages = function (input, onChange) {
    for (var i = 0; i < input.files.length; i++) window.protoPages.push(input.files[i].name);
    input.value = '';
    onChange();
  };
  window.protoRenderPages = function (list, onChange) {
    list.innerHTML = '';
    list.hidden = window.protoPages.length === 0;
    for (var i = 0; i < window.protoPages.length; i++) {
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.textContent = (i + 1) + '. sivu — ' + window.protoPages[i];
      var drop = document.createElement('button');
      drop.type = 'button';
      drop.textContent = 'Poista';
      drop.setAttribute('data-at', String(i));
      drop.onclick = function () {
        window.protoPages.splice(Number(this.getAttribute('data-at')), 1);
        onChange();
      };
      li.appendChild(name);
      li.appendChild(drop);
      list.appendChild(li);
    }
  };
})();
`;

function switcher(current: PrototypeVariant): Raw {
  return html`<nav class="proto-switch" aria-label="Prototyypin versio">
    ${PROTOTYPE_VARIANTS.map((variant) => html`<a
      href="/intake?variant=${variant}"
      class="${variant === current ? "on" : ""}">${variant}</a>`)}
    <span style="padding:0 .6rem 0 .2rem">${NAMES[current]}</span>
  </nav>`;
}

/** A: one big box, two picture buttons under it, the button says what it will do. */
function variantA(): Raw {
  return html`<h1>Lisää resepti</h1>
    <form id="proto-a" onsubmit="return false">
      <!-- no visible label: the placeholder says it -->
      <textarea id="a-box" class="proto-box" rows="6" aria-label="Linkki tai reseptin teksti"
        placeholder="Liitä linkki reseptisivulle tai reseptin teksti"></textarea>
      <p class="proto-detect" id="a-detect" aria-live="polite"></p>

      <div class="proto-pick">
        <label>${CAMERA} Ota kuva
          <input id="a-camera" type="file" accept="image/*" capture="environment" />
        </label>
        <label>${PICTURES} Valitse kuvia
          <input id="a-photos" type="file" accept="image/*" multiple />
        </label>
      </div>
      <ul class="proto-pages" id="a-pages" hidden></ul>

      <button type="submit" class="primary proto-wide" id="a-go" disabled>Muodosta resepti</button>
    </form>

    <p class="proto-small">Muistatko vain nimen?
      <button type="button" id="a-name-open">Tallenna pelkkä nimi</button></p>
    <form id="a-name" class="stacked" hidden onsubmit="return false">
      <label for="a-title">Reseptin nimi</label>
      <input id="a-title" type="text" placeholder="Esim. mummin lihapullat" autocomplete="off" />
      <button type="submit">Tallenna keskeneräisenä</button>
    </form>

    <script>${raw(`
      (function () {
        var box = document.getElementById('a-box');
        var detect = document.getElementById('a-detect');
        var go = document.getElementById('a-go');
        var list = document.getElementById('a-pages');
        function update() {
          window.protoRenderPages(list, update);
          var pages = window.protoPages.length;
          var k = window.protoKind(box.value);
          box.disabled = pages > 0;
          if (pages > 0) {
            detect.innerHTML = '<strong>' + pages + (pages === 1 ? ' kuva' : ' kuvaa') + '</strong> — voit lisätä saman reseptin sivuja.';
            go.textContent = 'Lue resepti kuvista';
          } else if (k === 'link') {
            detect.innerHTML = 'Linkki: <strong>' + window.protoHost(box.value) + '</strong>. Sivu luetaan taustalla.';
            go.textContent = 'Hae resepti sivulta';
          } else if (k === 'text' || k === 'name') {
            detect.innerHTML = k === 'name'
              ? 'Pelkkä nimi? Tallenna se alta, tai liitä koko resepti.'
              : 'Reseptin teksti, <strong>' + window.protoLines(box.value) + ' riviä</strong>.';
            go.textContent = 'Muodosta resepti';
          } else {
            detect.textContent = '';
            go.textContent = 'Muodosta resepti';
          }
          go.disabled = pages === 0 && k !== 'link' && k !== 'text';
        }
        box.addEventListener('input', update);
        document.getElementById('a-camera').onchange = function () { window.protoAddPages(this, update); };
        document.getElementById('a-photos').onchange = function () { window.protoAddPages(this, update); };
        document.getElementById('proto-a').onsubmit = function () {
          var pages = window.protoPages.length;
          window.protoSay(pages > 0
            ? 'aloittaisi tuonnin ' + pages + ' kuvasta.'
            : window.protoKind(box.value) === 'link'
              ? 'hakisi reseptin osoitteesta ' + window.protoHost(box.value) + '.'
              : 'muodostaisi reseptin liitetystä tekstistä.');
          return false;
        };
        document.getElementById('a-name-open').onclick = function () {
          var form = document.getElementById('a-name');
          form.hidden = false;
          var title = document.getElementById('a-title');
          if (window.protoKind(box.value) === 'name') title.value = box.value.trim();
          title.focus();
        };
        document.getElementById('a-name').onsubmit = function () {
          window.protoSay('tallentaisi keskeneräisen reseptin "' + document.getElementById('a-title').value + '".');
          return false;
        };
        update();
      })();
    `)}</script>`;
}

/** B: a one-line box that grows; a short line is a name, so name-only needs no section. */
function variantB(): Raw {
  return html`<h1>Lisää resepti</h1>
    <form id="proto-b" onsubmit="return false">
      <label for="b-box">Reseptin nimi, linkki tai koko teksti</label>
      <textarea id="b-box" class="proto-box" rows="1" style="resize:none;overflow:hidden"
        placeholder="Esim. kotikokki.net/… tai mummin lihapullat"></textarea>
      <p class="proto-detect" id="b-detect" aria-live="polite"></p>
      <div class="proto-buttons" id="b-buttons">
        <button type="button" class="proto-ghost" id="b-paste">Liitä leikepöydältä</button>
      </div>
    </form>

    <div class="proto-or">tai kuvaa painettu resepti</div>
    <label class="proto-tile">${CAMERA}
      <div><strong>Ota kuva</strong><span>Keittokirjan sivu tai lehtileike</span></div>
      <input class="proto-file" id="b-camera" type="file" accept="image/*" capture="environment" />
    </label>
    <label class="proto-tile">${PICTURES}
      <div><strong>Valitse kuvista</strong><span>Enintään 8 sivua samasta reseptistä</span></div>
      <input class="proto-file" id="b-photos" type="file" accept="image/*" multiple />
    </label>
    <ul class="proto-pages" id="b-pages" hidden style="margin-top:.5rem"></ul>
    <button type="button" class="primary proto-wide" id="b-read" hidden>Lue resepti kuvista</button>

    <script>${raw(`
      (function () {
        var box = document.getElementById('b-box');
        var detect = document.getElementById('b-detect');
        var buttons = document.getElementById('b-buttons');
        var list = document.getElementById('b-pages');
        var read = document.getElementById('b-read');
        function grow() { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight + 2, 320) + 'px'; }
        function button(label, primary, say) {
          var b = document.createElement('button');
          b.type = 'button';
          b.textContent = label;
          if (primary) b.className = 'primary';
          b.onclick = function () { window.protoSay(say); };
          buttons.appendChild(b);
        }
        function update() {
          grow();
          var k = window.protoKind(box.value);
          var v = box.value.trim();
          buttons.innerHTML = '';
          if (k === 'empty') {
            detect.textContent = '';
            var paste = document.createElement('button');
            paste.type = 'button';
            paste.className = 'proto-ghost';
            paste.textContent = 'Liitä leikepöydältä';
            paste.onclick = function () {
              if (!navigator.clipboard || !navigator.clipboard.readText) { box.focus(); return; }
              navigator.clipboard.readText().then(function (t) { box.value = t; update(); }, function () { box.focus(); });
            };
            buttons.appendChild(paste);
          } else if (k === 'link') {
            detect.innerHTML = 'Linkki: <strong>' + window.protoHost(v) + '</strong>';
            button('Hae resepti sivulta', true, 'hakisi reseptin osoitteesta ' + window.protoHost(v) + '.');
          } else if (k === 'name') {
            detect.innerHTML = 'Pelkkä nimi — reseptin voi täydentää myöhemmin.';
            button('Tallenna nimellä', true, 'tallentaisi keskeneräisen reseptin "' + v + '".');
          } else {
            detect.innerHTML = 'Reseptin teksti, <strong>' + window.protoLines(v) + ' riviä</strong>.';
            button('Muodosta resepti', true, 'muodostaisi reseptin liitetystä tekstistä.');
          }
        }
        function pagesChanged() {
          window.protoRenderPages(list, pagesChanged);
          var n = window.protoPages.length;
          read.hidden = n === 0;
          read.textContent = n === 1 ? 'Lue resepti kuvasta' : 'Lue resepti ' + n + ' kuvasta';
        }
        read.onclick = function () { window.protoSay('aloittaisi tuonnin ' + window.protoPages.length + ' kuvasta.'); };
        box.addEventListener('input', update);
        box.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && window.protoKind(box.value) !== 'text' && !e.shiftKey) {
            var first = buttons.querySelector('button.primary');
            if (first) { e.preventDefault(); first.click(); }
          }
        });
        document.getElementById('b-camera').onchange = function () { window.protoAddPages(this, pagesChanged); };
        document.getElementById('b-photos').onchange = function () { window.protoAddPages(this, pagesChanged); };
        update();
      })();
    `)}</script>`;
}

/** C: a message composer docked above the tabs; the page above is help and the imports. */
function variantC(): Raw {
  return html`<h1>Lisää resepti</h1>
    <p>Lähetä alla olevaan kenttään mikä tahansa näistä, niin siitä tehdään resepti:</p>
    <ul class="proto-hint">
      <li><span>🔗</span><span>Linkki reseptisivulle</span></li>
      <li><span>📋</span><span>Kopioitu reseptin teksti</span></li>
      <li><span>📷</span><span>Kuva keittokirjan sivusta — useampi sivu käy</span></li>
      <li><span>✏️</span><span>Pelkkä nimi, jos resepti ei ole käsillä</span></li>
    </ul>

    <div class="proto-composer">
      <div class="proto-composer-inner">
        <ul class="proto-pages" id="c-pages" hidden style="margin:0 0 .4rem"></ul>
        <p class="proto-detect" id="c-detect" aria-live="polite"></p>
        <form class="proto-composer-row" id="proto-c" onsubmit="return false">
          <label class="button proto-round" title="Kuva" style="background:var(--surface);color:var(--fg)">${CAMERA}
            <input class="proto-file" id="c-photos" type="file" accept="image/*" multiple />
          </label>
          <textarea id="c-box" rows="1" placeholder="Linkki, teksti tai nimi"></textarea>
          <button type="submit" class="proto-round primary" id="c-go" disabled aria-label="Lähetä">${SEND}</button>
        </form>
      </div>
    </div>

    <script>${raw(`
      (function () {
        document.body.className += ' proto-c';
        var box = document.getElementById('c-box');
        var detect = document.getElementById('c-detect');
        var go = document.getElementById('c-go');
        var list = document.getElementById('c-pages');
        function update() {
          box.style.height = 'auto';
          box.style.height = Math.min(box.scrollHeight + 2, 144) + 'px';
          window.protoRenderPages(list, update);
          var n = window.protoPages.length;
          var k = window.protoKind(box.value);
          if (n > 0) detect.textContent = n + (n === 1 ? ' kuva' : ' kuvaa') + ' — luetaan reseptiksi';
          else if (k === 'link') detect.textContent = 'Haetaan sivulta ' + window.protoHost(box.value);
          else if (k === 'name') detect.textContent = 'Tallennetaan pelkkä nimi';
          else if (k === 'text') detect.textContent = 'Muodostetaan resepti tekstistä';
          else detect.textContent = '';
          go.disabled = n === 0 && k === 'empty';
        }
        box.addEventListener('input', update);
        document.getElementById('c-photos').onchange = function () { window.protoAddPages(this, update); };
        document.getElementById('proto-c').onsubmit = function () {
          var n = window.protoPages.length;
          var k = window.protoKind(box.value);
          var v = box.value.trim();
          window.protoSay(n > 0 ? 'aloittaisi tuonnin ' + n + ' kuvasta.'
            : k === 'link' ? 'hakisi reseptin osoitteesta ' + window.protoHost(v) + '.'
            : k === 'name' ? 'tallentaisi keskeneräisen reseptin "' + v + '".'
            : 'muodostaisi reseptin liitetystä tekstistä.');
          return false;
        };
        update();
      })();
    `)}</script>`;
}

export function prototypeIntake(variant: PrototypeVariant, jobs: Raw): Raw {
  const body = variant === "A" ? variantA() : variant === "B" ? variantB() : variantC();
  return html`<style>${raw(STYLE)}</style>
    ${switcher(variant)}
    <script>${raw(SCRIPT)}</script>
    <div id="proto-result" class="proto-result" hidden></div>
    ${body}
    ${jobs}`;
}
