/**
 * The typed browser half of queued recipe intake. The compiled ES5 bundle is
 * embedded only on intake forms; the server still owns markup and validation.
 *
 * Keep feature detection and the serial photograph pipeline: one full-size
 * bitmap at a time, discarded before encoding, and only small JPEGs retained.
 */
interface PreparedPage {
  image: string;
  thumb: string;
  bytes: number;
}

interface IntakeBody {
  images?: Array<{ image: string; mediaType: string }>;
  url?: string;
  sourceText?: string;
  guidance?: string;
  recipeId?: string;
  mode?: string;
}

interface IntakeFailure extends Error {
  step?: string;
  status?: number;
  member?: boolean;
}

(function () {
  var form = document.getElementById('intake') as HTMLFormElement;
  var progress = document.getElementById('progress') as HTMLElement;
  var status = document.getElementById('status') as HTMLElement;
  var photoHelp = document.getElementById('photo-help') as HTMLElement;
  var chosenList = document.getElementById('chosen') as HTMLElement;
  var guidanceFields = document.getElementById('guidance-fields') as HTMLElement;
  if (!form || !progress || !status || !photoHelp || !chosenList || !window.fetch || !window.Promise) return;

  var button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  if (!button) return;
  var textField = form.elements.namedItem('sourceText') as HTMLTextAreaElement;
  var camera = form.elements.namedItem('camera') as HTMLInputElement;
  var photo = form.elements.namedItem('photo') as HTMLInputElement;
  if (!textField || !camera || !photo) return;
  var linkField = form.elements.namedItem('sourceUrl') as HTMLInputElement | null;
  var guidance = form.elements.namedItem('importGuidance') as HTMLTextAreaElement | null;
  var recipeId = form.elements.namedItem('recipeId') as HTMLInputElement | null;
  var mode = form.elements.namedItem('mode') as RadioNodeList | HTMLInputElement | null;

  // These three numeric limits come from the same server constants that
  // validate uploads. Data attributes avoid importing any Worker/model code.
  var MAX_PAGES = Number(form.getAttribute('data-max-pages'));
  var MAX_PAGE_BYTES = Number(form.getAttribute('data-max-page-bytes'));
  var MAX_PAGES_BYTES = Number(form.getAttribute('data-max-pages-bytes'));
  if (![MAX_PAGES, MAX_PAGE_BYTES, MAX_PAGES_BYTES].every(function (value) {
    return isFinite(value) && value > 0 && value % 1 === 0;
  })) return;
  function showGuidance() {
    if (guidanceFields) guidanceFields.hidden = !linkField || !linkField.value.trim();
  }
  if (linkField && linkField.addEventListener) {
    linkField.addEventListener('input', showGuidance);
  }
  showGuidance();
  button.disabled = false;
  status.textContent = '';
  var photosWork = typeof window.createImageBitmap === 'function' && !!window.URL &&
    typeof window.URL.createObjectURL === 'function';
  if (!photosWork) {
    camera.disabled = true;
    photo.disabled = true;
    photoHelp.textContent = 'Kuvan tuonti ei ole käytettävissä tässä selaimessa.';
  }
  var LONG_EDGE = 1500;
  var THUMB_EDGE = 192;

  // The pages to import, in the order they were added, already reduced to what
  // will be sent: a ~1500 px JPEG and a thumbnail-sized one, both as base64.
  // Camera shots and library picks land in the same list; nothing
  // distinguishes them after this.
  //
  // A page is shrunk the moment it is chosen and the original photograph is
  // let go there and then. That is the fix for #218. Keeping the File and
  // pointing the thumbnail at it looked free — the thumbnail is 3 rem — but a
  // browser decodes a picture at its own size before it scales it down, so a
  // 12-megapixel photograph cost about 50 MB of live memory per page however
  // small it was drawn. Four of those, plus a fifth full-size decode when the
  // button was finally pressed, is more than a phone will lend a tab, and the
  // tab was killed on the page the member had just finished choosing.
  var pages: PreparedPage[] = [];

  // How many pages are being read right now. Reading is one serial chain, for
  // the reason it always was — the order has to survive, and two photographs
  // decoding at once is the thing being avoided.
  var reading = 0;
  var chain = window.Promise.resolve();
  var notice = '';

  // A canvas of this picture, no larger than the given long edge.
  function scaled(bitmap: ImageBitmap, edge: number): HTMLCanvasElement {
    var scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  // The canvas as base64 JPEG, and then emptied: a canvas holds its pixels
  // until something says otherwise, and this one has served its purpose.
  function spend(canvas: HTMLCanvasElement, quality: number): string {
    var url = canvas.toDataURL('image/jpeg', quality);
    canvas.width = 1;
    canvas.height = 1;
    return url.slice(url.indexOf(',') + 1);
  }

  function shrink(file: File): Promise<PreparedPage> {
    return window.createImageBitmap(file).then(function (bitmap) {
      var full = scaled(bitmap, LONG_EDGE);
      var small = scaled(bitmap, THUMB_EDGE);
      // The decoded photograph goes now, not at the next collection.
      if (bitmap.close) bitmap.close();
      var image = spend(full, 0.85);
      return {
        image: image,
        thumb: 'data:image/jpeg;base64,' + spend(small, 0.6),
        bytes: image.length
      };
    });
  }

  function totalBytes() {
    var total = 0;
    for (var i = 0; i < pages.length; i++) total += pages[i]!.bytes;
    return total;
  }

  // Which way in the member is using, worked out the same way the submit
  // handler works it out, so a report says which import gave way.
  function currentRoute() {
    if (pages.length > 0) return 'photographed';
    return linkField && linkField.value.trim() ? 'linked' : 'pasted';
  }

  // Tell the Worker that this import gave way here, so the log line names the
  // step rather than only the fact (#222). Best-effort by construction:
  // nothing waits for it, it is never on the path of a working import, and
  // every way it can fail is swallowed — a report must not become another
  // thing that can fail an import. keepalive so a tab that is going away
  // still gets the line out.
  function report(step: string, detail?: unknown, status?: number): void {
    try {
      var body = JSON.stringify({
        step: step,
        detail: String(detail === undefined || detail === null ? '' : detail).slice(0, 300),
        status: status || 0,
        route: currentRoute(),
        pages: pages.length,
        bytes: totalBytes()
      });
      if (window.fetch) {
        window.fetch('/api/intake/failures', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true
        }).then(null, function () {});
      } else if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/intake/failures', body);
      }
    } catch (ignored) {
      // Nothing to do: the import has already failed, and no member is
      // waiting on the report of it.
    }
  }

  // A failure carries the hop it happened at, so the report and the wording
  // both know whether the browser gave up or the server refused.
  function tagged(error: unknown, step: string, status?: number): IntakeFailure {
    var carried = new Error(String((error && (error as Error).message) || error || step)) as IntakeFailure;
    carried.step = step;
    carried.status = status || 0;
    return carried;
  }

  // Rebuilt whole every time, so the numbering and the remove buttons always
  // agree with the list rather than with the order things were added.
  function renderPages() {
    while (chosenList.firstChild) chosenList.removeChild(chosenList.firstChild);
    chosenList.hidden = pages.length === 0;

    pages.forEach(function (page, index) {
      var item = document.createElement('li');

      var thumb = document.createElement('img');
      thumb.src = page.thumb;
      thumb.alt = '';
      item.appendChild(thumb);

      var name = document.createElement('span');
      name.className = 'page-name';
      name.textContent = 'Sivu ' + (index + 1);
      item.appendChild(name);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'quiet';
      remove.textContent = 'Poista';
      remove.addEventListener('click', function () {
        pages.splice(index, 1);
        notice = '';
        refresh();
      });
      item.appendChild(remove);

      chosenList.appendChild(item);
    });
  }

  // Nothing may be sent while a page is still being read, or half a recipe
  // would go. The wording says which page is being read, because on a phone
  // this is the part that takes a moment.
  function refresh() {
    renderPages();
    button.disabled = reading > 0;
    if (photosWork) {
      camera.disabled = reading > 0;
      photo.disabled = reading > 0;
    }
    if (reading > 0) {
      status.textContent =
        'Luetaan kuvaa ' + (pages.length + 1) + '/' + (pages.length + reading) + '…';
    } else {
      status.textContent = notice;
    }
  }

  function prepare(file: File): () => Promise<void> {
    return function () {
      return shrink(file).then(function (page) {
        if (page.bytes > MAX_PAGE_BYTES) {
          notice = 'Yksi kuvista on liian suuri lähetettäväksi. Ota se uudelleen.';
          report('oversize', 'one page is ' + page.bytes + ' base64 bytes');
        } else if (totalBytes() + page.bytes > MAX_PAGES_BYTES) {
          notice = 'Kuvat ovat yhteensä liian suuria. Poista jokin sivu ja yritä uudelleen.';
          report('oversize', 'pages total ' + (totalBytes() + page.bytes) + ' base64 bytes');
        } else {
          pages.push(page);
        }
      }, function (error) {
        notice = 'Yhtä kuvista ei voitu lukea. Kokeile ottaa se uudelleen.';
        report('shrink', (error && error.message) || 'the page could not be decoded');
      }).then(function () {
        reading--;
        refresh();
      });
    };
  }

  function addFrom(input: HTMLInputElement): void {
    var files = input.files;
    if (!files) return;
    var dropped = 0;
    notice = '';
    for (var i = 0; i < files.length; i++) {
      if (pages.length + reading >= MAX_PAGES) { dropped++; continue; }
      reading++;
      chain = chain.then(prepare(files[i]!));
    }

    // Clearing the input is what lets the same camera button be pressed again
    // for the next page: without it a second identical capture fires no change.
    input.value = '';
    if (dropped) notice = 'Enintään ' + MAX_PAGES + ' sivua yhdessä reseptissä.';
    refresh();
  }

  ['camera', 'photo'].forEach(function (id) {
    var input = document.getElementById(id) as HTMLInputElement | null;
    if (input) {
      input.addEventListener('change', function () { addFrom(input!); });
    }
  });

  form.addEventListener('submit', function (event) {
    var text = textField.value.trim();
    var link = linkField ? linkField.value.trim() : '';
    var photographed = pages.length > 0;
    // A photograph wins over an address and an address over an already-pasted
    // box, so the import is the newest thing the member reached for. The
    // server applies the same order; this only keeps the wording honest.
    var linked = !photographed && !!link;
    event.preventDefault();
    if (!photographed && !linked && !text) {
      status.textContent = 'Anna reseptin osoite, liitä sen teksti tai valitse kuva.';
      return;
    }
    button.disabled = true;
    status.textContent = photographed
      ? 'Lähetetään sivuja…'
      : linked ? 'Haetaan sivua…' : 'Luetaan reseptiä…';
    progress.hidden = false;
    progress.textContent = 'Luetaan reseptiä…';

    // The pages are already shrunk — that happened as each one was chosen —
    // so pressing the button decodes nothing and costs no memory. Nor is a
    // linked page fetched here: the address goes into the job and the queue
    // consumer reads the site, so a slow page cannot hold this request open
    // and navigating away does not lose the import.
    var body: IntakeBody;
    if (photographed) {
      body = { images: pages.map(function (page) {
        return { image: page.image, mediaType: 'image/jpeg' };
      }) };
    } else if (linked) {
      body = { url: link };
      // Keep pasted text in the request even while an address is present. The
      // server still gives ordinary links precedence, but can use this text
      // immediately when the preserved address is an unsupported K-Ruoka link.
      if (text) body.sourceText = text;
      if (guidance && guidance.value.trim()) {
        body.guidance = guidance.value.trim();
      }
    } else {
      body = { sourceText: text };
    }

    Promise.resolve(body)
      .then(function (body) {
        if (recipeId) body.recipeId = recipeId.value;
        if (mode) body.mode = mode.value;
        var payload;
        try {
          payload = JSON.stringify(body);
        } catch (error) {
          throw tagged(error, 'encode');
        }
        return fetch('/api/intake/imports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        }).then(null, function (error) {
          // The request never left. This is the hop that used to look
          // identical to a server refusal, on the screen and in the log.
          throw tagged(error, 'send');
        }).then(function (response) {
          if (!response.ok) {
            // A 400 is this app refusing in Finnish it wrote itself — an
            // address that is not one, or too many pages. That wording is
            // worth showing; anything else stays generic.
            return response.json().then(function (body) {
              var refusal = tagged(
                (body && body.error) || 'no error body',
                'refused',
                response.status
              );
              refusal.member = response.status === 400 && !!(body && body.error);
              throw refusal;
            }, function () {
              throw tagged('unreadable error body', 'refused', response.status);
            });
          }
          return response.json().then(null, function (error) {
            throw tagged(error, 'reply', response.status);
          });
        });
      })
      .then(function (job: { id?: string } | null) {
        status.textContent = 'Reseptiä käsitellään taustalla. Voit jatkaa Ruokalistan käyttöä.';
        progress.hidden = true;
        progress.textContent = '';
        button.disabled = false;
        if (job && job.id) {
          window.location.assign('/intake?started=' + encodeURIComponent(job.id) +
            (recipeId ? '&recipe=' + encodeURIComponent(recipeId.value) : ''));
        }
      })
      .catch(function (error: IntakeFailure) {
        var step = (error && error.step) || 'unknown';
        var answered = step === 'refused' || step === 'reply';
        // Nothing is reported once the Worker has answered. The request
        // arrived, so the Worker already has a record of it, and a line
        // saying the browser gave up would be a false one — that name is a
        // promise that nothing left the device.
        if (!answered) report(step, error && error.message, error && error.status);
        // Only wording this island wrote is shown. Anything else — a transport
        // error, a server body — is generic, so no English or raw response
        // text ever lands on a member's screen.
        //
        // The two generic sentences are deliberately different (#222). "The
        // recipe never left this device" and "the server would not take it"
        // are different things to do next, and until now they read the same —
        // which is what made #218 take two investigations to settle.
        status.textContent = error && error.member
          ? error.message
          : answered
            ? 'Palvelin ei ottanut reseptiä vastaan. Yritä hetken kuluttua uudelleen.'
            : 'Reseptin lähetys ei onnistunut tällä laitteella. Tarkista verkkoyhteys ja yritä uudelleen.';
        // The counts belonged to an attempt that came to nothing. Leaving them
        // up would read as a half-finished import that is still going.
        progress.hidden = true;
        progress.textContent = '';
        button.disabled = false;
      });
  });
})();

export {};
