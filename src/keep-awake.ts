import { html, raw, type Raw } from "./html.ts";

/*
 * A two-second black H.264/AAC clip. The silent audio track is intentional:
 * old iOS keeps the display awake while inline media is playing. Generated
 * locally with ffmpeg rather than copied from a compatibility library.
 */
const SILENT_VIDEO =
  "data:video/mp4;base64,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bWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0wIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PTAgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9MCBpbnRyYV9yZWZyZXNoPTAgcmM9Y3JmIG1idHJlZT0wIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTAAgAAAAApliIQ6JigACQLgARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcAAAAFQZogFKUBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBw==";

/* Deliberately ES5 syntax: this string reaches browsers without transpilation. */
const KEEP_AWAKE_ISLAND = `
(function () {
  var root = document.getElementById('keep-awake');
  if (!root) return;

  var button = document.getElementById('keep-awake-button');
  var status = document.getElementById('keep-awake-status');
  var sentinel = null;
  var video = null;
  var acquiring = false;
  var active = true;
  var requestGeneration = 0;
  var nativeSupported = !!(
    navigator.wakeLock &&
    typeof navigator.wakeLock.request === 'function'
  );
  var useNative = nativeSupported;

  function isVisible() {
    return !document.visibilityState || document.visibilityState === 'visible';
  }

  function offer(message) {
    root.hidden = false;
    button.hidden = false;
    status.textContent = message;
  }

  function confirmed() {
    root.hidden = false;
    button.hidden = true;
    status.textContent = 'Näyttö pysyy hereillä.';
  }

  function ignoreRejection(result) {
    if (result && typeof result.then === 'function') {
      result.then(function () {}, function () {});
    }
  }

  function releaseNative() {
    requestGeneration += 1;
    acquiring = false;
    var held = sentinel;
    sentinel = null;
    if (held && typeof held.release === 'function') {
      try {
        ignoreRejection(held.release());
      } catch (_error) {}
    }
  }

  function nativeFailed() {
    acquiring = false;
    useNative = false;
    if (active && isVisible()) {
      offer('Näyttö voi sammua. Ota varatapa käyttöön napauttamalla.');
    }
  }

  function acquireNative() {
    if (!active || !isVisible() || acquiring || sentinel) return;
    acquiring = true;
    var generation = requestGeneration + 1;
    requestGeneration = generation;

    var request;
    try {
      request = navigator.wakeLock.request('screen');
    } catch (_error) {
      nativeFailed();
      return;
    }

    if (!request || typeof request.then !== 'function') {
      nativeFailed();
      return;
    }

    request.then(function (lock) {
      if (generation !== requestGeneration || !active || !isVisible()) {
        if (lock && typeof lock.release === 'function') {
          ignoreRejection(lock.release());
        }
        return;
      }

      acquiring = false;
      sentinel = lock;
      root.hidden = true;
      if (lock && typeof lock.addEventListener === 'function') {
        lock.addEventListener('release', function () {
          if (sentinel === lock) sentinel = null;
        });
      }
    }, function () {
      if (generation === requestGeneration) nativeFailed();
    });
  }

  function legacyVideo() {
    if (video) return video;
    video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('preload', 'auto');
    video.setAttribute('aria-hidden', 'true');
    video.className = 'keep-awake-video';
    video.src = '${SILENT_VIDEO}';
    video.addEventListener('timeupdate', function () {
      if (video.currentTime > 0.5) video.currentTime = 0.1;
    });
    root.appendChild(video);
    return video;
  }

  function legacyFailed() {
    if (active && isVisible()) {
      offer('Näyttö voi sammua. Napauta painiketta pitääksesi sen hereillä.');
    }
  }

  function acquireLegacy() {
    if (!active || !isVisible()) return;
    var result;
    try {
      result = legacyVideo().play();
    } catch (_error) {
      legacyFailed();
      return;
    }

    if (result && typeof result.then === 'function') {
      result.then(confirmed, legacyFailed);
    } else {
      confirmed();
    }
  }

  function stopCurrent() {
    releaseNative();
    if (video) {
      try { video.pause(); } catch (_error) {}
    }
  }

  button.addEventListener('click', function () {
    if (useNative) acquireNative();
    else acquireLegacy();
  });

  document.addEventListener('visibilitychange', function () {
    if (!isVisible()) {
      stopCurrent();
    } else if (useNative) {
      acquireNative();
    } else if (video) {
      acquireLegacy();
    }
  });

  window.addEventListener('pagehide', function () {
    active = false;
    stopCurrent();
  });

  window.addEventListener('pageshow', function () {
    active = true;
    if (useNative) {
      acquireNative();
    } else if (video) {
      acquireLegacy();
    }
  });

  if (useNative) {
    acquireNative();
  } else {
    offer('Vanhemmalla laitteella näyttö pidetään hereillä napautuksen jälkeen.');
  }
}());`;

export function keepAwake(): Raw {
  return html`<div id="keep-awake" class="keep-awake" hidden>
      <button id="keep-awake-button" type="button">Pidä näyttö hereillä</button>
      <span id="keep-awake-status" role="status"></span>
    </div>
    <script>${raw(KEEP_AWAKE_ISLAND)}</script>`;
}
