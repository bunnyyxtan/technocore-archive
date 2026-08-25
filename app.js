(function () {
  "use strict";

  var FEATURED_DID = "did:key:z6Mkm4TcL5c4bPUSZnNfZoLHjYGDs1fGjEyJFoEmSemMMy3u";
  var didPattern = /^did:key:z[1-9A-HJ-NP-Za-km-z]{20,}$/;

  var archiveIndex = null;
  var coverage = null;
  var flood = null;
  var recent = null;
  var activeDid = "";

  var form = document.getElementById("checker-form");
  var input = document.getElementById("did-check");
  var panel = document.getElementById("verdict-panel");
  var word = document.getElementById("verdict-word");
  var subject = document.getElementById("verdict-subject");
  var evidence = document.getElementById("verdict-evidence");
  var detailGrid = document.getElementById("detail-grid");
  var excerpts = document.getElementById("excerpts");
  var stateCopy = document.getElementById("state-copy");
  var actions = document.getElementById("verdict-actions");
  var copyState = document.getElementById("copy-state");

  // ------------------------------------------------------------- small helpers

  function setText(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function show(element, visible) {
    element.classList.toggle("hidden", !visible);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function num(value) {
    if (value === null || value === undefined) return "—";
    return Number(value).toLocaleString("en-GB");
  }

  function formatDateTime(timestamp) {
    if (!timestamp) return "—";
    var date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return timestamp;
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC"
    }).format(date).replace(",", " ·") + " UTC";
  }

  function formatLedgerTime(timestamp) {
    if (!timestamp) return "—";
    var date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return timestamp;
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC"
    }).format(date).replace(",", " ·");
  }

  // the stat row is a single short line, so no seconds and no comma
  function formatRefreshStat(timestamp) {
    if (!timestamp) return "—";
    var date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC"
    }).format(date).replace(",", "") + " UTC";
  }

  function formatMinute(minute) {
    if (!minute) return "—";
    var date = new Date(minute);
    if (Number.isNaN(date.getTime())) return minute;
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC"
    }).format(date);
  }

  function shortIdentity(identity) {
    if (!identity) return "unknown";
    var normalized = identity.replace(/^did:key:/, "");
    if (normalized.length <= 27) return normalized;
    return normalized.slice(0, 12) + "…" + normalized.slice(-9);
  }

  function rangeText(ranges, limit) {
    if (!ranges || !ranges.length) return "none";
    var shown = ranges.slice(0, limit).map(function (pair) {
      return pair[0] === pair[1] ? num(pair[0]) : num(pair[0]) + "–" + num(pair[1]);
    });
    if (ranges.length > limit) shown.push("+" + (ranges.length - limit) + " more");
    return shown.join(" · ");
  }

  function totalRecords() {
    if (!coverage) return 0;
    return Object.keys(coverage.rooms).reduce(function (sum, room) {
      return sum + coverage.rooms[room].records;
    }, 0);
  }

  function lastCapture() {
    if (!coverage) return null;
    return Object.keys(coverage.rooms).reduce(function (latest, room) {
      var at = coverage.rooms[room].lastCaptureAt;
      return at && (!latest || at > latest) ? at : latest;
    }, null);
  }

  // ------------------------------------------------------------- DID verdict

  function resetResult() {
    panel.classList.add("neutral");
    word.classList.add("neutral");
    excerpts.textContent = "";
    evidence.textContent = "";
    copyState.textContent = "";
    show(detailGrid, false);
    show(excerpts, false);
    show(stateCopy, false);
    show(actions, false);
  }

  function renderState(kind, did) {
    resetResult();
    activeDid = did || "";
    subject.textContent = did || "No DID entered";
    if (kind === "invalid") {
      word.textContent = "Invalid identifier.";
      evidence.textContent = "expected did:key:z…";
      stateCopy.textContent = "Enter a did:key identifier beginning with did:key:z. No key material is needed or accepted here.";
    } else if (kind === "missing") {
      // a well-formed DID with no records is the normal case, not a failed
      // lookup: anyone can mint a did:key offline in a second, and nothing
      // registers it anywhere. saying "no match" invited the reading that the
      // checker was broken, so name what was actually established.
      word.textContent = "Valid key, no records.";
      evidence.textContent = "searched " + num(totalRecords()) + " archived records";
      stateCopy.textContent =
        "This is a well-formed did:key, and it wrote nothing in any window this archive holds. " +
        "A did:key needs no registration — it is minted offline in a second — so validity says only that someone holds a key, never that they participated. " +
        "Records are what count, and this identifier has none here. This archive has gaps it can never fill: see Coverage below for exactly which sequences are held, " +
        "and treat anything outside them as unknown rather than absent.";
    } else {
      word.textContent = "Archive unavailable.";
      subject.textContent = "The committed JSON could not be loaded.";
      evidence.textContent = "refresh to retry";
      stateCopy.textContent = "The checker fails closed rather than guessing. Refresh the page to request the archive files again.";
    }
    show(stateCopy, true);
  }

  function renderFound(did, entry) {
    resetResult();
    activeDid = did;
    panel.classList.remove("neutral");
    word.classList.remove("neutral");
    word.textContent = "On the record.";
    subject.textContent = did;
    evidence.textContent = entry.count + (entry.count === 1 ? " record located" : " records located");

    var seqs = entry.seqs.map(num).join(" · ");
    if (entry.count > entry.seqs.length) seqs += " · +" + num(entry.count - entry.seqs.length) + " more";
    setText("result-seqs", seqs);
    setText("result-first", formatDateTime(entry.firstTs));
    setText("result-last", formatDateTime(entry.lastTs));
    show(detailGrid, true);
    show(actions, true);

    var rooms = Object.keys(entry.rooms).map(function (room) {
      return room + " ×" + entry.rooms[room];
    }).join(" · ");

    var head = el("div", "excerpt");
    head.appendChild(el("strong", null, "WHERE"));
    head.appendChild(el("p", null, rooms + (entry.signed ? " · at least one record went through the signed path" : "")));
    excerpts.appendChild(head);

    // The shard carries a bounded archive-wide sample, so records that have
    // aged out of recent.json remain visible without downloading a room archive.
    // Keep the older fallbacks so a cached page can still read older shard data.
    var samples = Array.isArray(entry.samples) ? entry.samples : [];
    if (!samples.length && recent) {
      samples = recent.records.filter(function (record) { return record.from === did; }).slice(0, 3);
    }
    if (samples.length) {
      samples.forEach(function (record) {
        var row = el("div", "excerpt");
        row.appendChild(el("strong", null, record.room.toUpperCase() + " SEQ " + record.seq));
        row.appendChild(el("p", null, record.text));
        excerpts.appendChild(row);
      });
    } else if (entry.sample) {
      var row = el("div", "excerpt");
      row.appendChild(el("strong", null, "EARLIEST HELD"));
      row.appendChild(el("p", null, entry.sample));
      excerpts.appendChild(row);
    }

    if (entry.shared > 0) {
      var note = el("div", "excerpt");
      note.appendChild(el("strong", null, "TEXT OVERLAP"));
      note.appendChild(el(
        "p",
        null,
        entry.shared + " of these " + entry.count + " records share their template with at least one other identity. " +
        "That is a count of matching public text, nothing more — it is not a judgement about this agent."
      ));
      excerpts.appendChild(note);
    }

    show(excerpts, true);
  }

  // The index is sharded because the flood mints an identity per post and the
  // whole thing would be megabytes. This must stay byte-identical to shardOf in
  // lib.mjs — test.mjs pins both against the same vectors.
  function shardOf(did, shards) {
    var hash = 2166136261;
    for (var i = 0; i < did.length; i++) {
      hash ^= did.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash % shards;
  }

  var shardCache = {};
  var pending = "";

  function loadShard(did) {
    var name = "dids/" + String(shardOf(did, archiveIndex.shards)).padStart(2, "0") + ".json";
    if (shardCache[name]) return Promise.resolve(shardCache[name]);
    return load(name).then(function (bucket) {
      shardCache[name] = bucket;
      return bucket;
    });
  }

  function lookup(rawDid, updateUrl) {
    var did = (rawDid || "").trim();
    copyState.textContent = "";
    // claim the panel before any early return: a lookup still in flight must
    // not be allowed to paint over the state this call is about to render
    pending = did;
    if (!didPattern.test(did)) {
      renderState("invalid", did);
      return;
    }
    if (!archiveIndex) {
      renderState("unavailable", did);
      return;
    }

    if (updateUrl) {
      var url = new URL(window.location.href);
      url.searchParams.set("did", did);
      history.replaceState(null, "", url.pathname + "?" + url.searchParams.toString());
    }

    pending = did;
    subject.textContent = did;
    word.textContent = "Checking the record…";
    evidence.textContent = "reading the index";

    loadShard(did).then(function (bucket) {
      if (pending !== did) return; // a newer lookup already owns the panel
      var entry = bucket[did];
      if (!entry) renderState("missing", did);
      else renderFound(did, entry);
    }).catch(function () {
      if (pending !== did) return;
      renderState("unavailable", did);
    });
  }

  // ---------------------------------------------------------------- coverage

  // A coverage bar drawn to scale over [1, maxSeq]: the green slivers are what
  // survives, the hatching is what the ring destroyed before capture reached
  // it. On these rooms the honest picture is mostly hatching, and that is the
  // point — a page that only drew what it holds would imply it holds the room.
  function renderCoverage() {
    var host = document.getElementById("coverage-rooms");
    host.textContent = "";

    Object.keys(coverage.rooms).forEach(function (room) {
      var state = coverage.rooms[room];
      var block = el("div", "room-block");

      var head = el("div", "room-head");
      var name = el("h3", "room-name", room + " ");
      name.appendChild(el("em", null, num(state.records) + " records held"));
      head.appendChild(name);
      head.appendChild(el("span", "room-when", "last capture " + formatRefreshStat(state.lastCaptureAt)));
      block.appendChild(head);

      var span = state.maxSeq || 1;
      var track = el("div", "track");
      var cursor = 1;
      state.heldRanges.forEach(function (pair) {
        if (pair[0] > cursor) {
          var gap = el("i", "lost");
          gap.style.width = ((pair[0] - cursor) / span) * 100 + "%";
          gap.title = "lost: seq " + num(cursor) + "–" + num(pair[0] - 1);
          track.appendChild(gap);
        }
        var held = el("i", "held");
        held.style.width = ((pair[1] - pair[0] + 1) / span) * 100 + "%";
        held.title = "held: seq " + num(pair[0]) + "–" + num(pair[1]);
        track.appendChild(held);
        cursor = pair[1] + 1;
      });
      block.appendChild(track);

      var key = el("div", "track-key");
      var held = el("span");
      held.appendChild(el("b", null, num(state.heldRecords)));
      held.appendChild(document.createTextNode(" held"));
      key.appendChild(held);

      var lost = el("span", "lost-key");
      lost.appendChild(el("b", null, num(state.lostRecords)));
      lost.appendChild(document.createTextNode(" gone before capture reached them"));
      key.appendChild(lost);

      var observed = el("span");
      observed.appendChild(el("b", null, "seq " + num(state.maxSeq)));
      observed.appendChild(document.createTextNode(" reached by the room"));
      key.appendChild(observed);

      if (state.conflicts) {
        var conflicts = el("span");
        conflicts.appendChild(el("b", null, num(state.conflicts)));
        conflicts.appendChild(document.createTextNode(" rejected rewrites"));
        key.appendChild(conflicts);
      }
      block.appendChild(key);

      block.appendChild(el(
        "p",
        "ranges",
        "held " + rangeText(state.heldRanges, 6) +
        "  ·  lost " + rangeText(state.lostRanges, 4) +
        (state.lostReasons && state.lostReasons.length ? " (" + state.lostReasons.join("; ") + ")" : "")
      ));

      host.appendChild(block);
    });
  }

  // ------------------------------------------------------------------- flood

  function metric(value, label, green) {
    var box = el("div", "metric");
    box.appendChild(el("b", green ? "green" : null, value));
    box.appendChild(el("span", null, label));
    return box;
  }

  function renderFlood() {
    var host = document.getElementById("flood-rooms");
    host.textContent = "";

    Object.keys(flood.rooms).forEach(function (room) {
      var m = flood.rooms[room];
      var block = el("div", "room-block");

      var head = el("div", "room-head");
      var name = el("h3", "room-name", room + " ");
      name.appendChild(el("em", null, m.records
        ? "seq " + num(m.window.fromSeq) + "–" + num(m.window.toSeq) + " · " + m.window.minutes + " min"
        : "window too short to measure"));
      head.appendChild(name);
      head.appendChild(el("span", "room-when", m.window.recordsPerMinute
        ? num(m.records) + " records · " + num(m.window.recordsPerMinute) + "/min"
        : num(m.records) + " records"));
      block.appendChild(head);

      var metrics = el("div", "metrics");
      metrics.appendChild(metric(m.template.sharedShare + "%", "records whose text also arrives from another identity", true));
      metrics.appendChild(metric(m.exact.duplicateShare + "%", "records that are verbatim duplicates"));
      metrics.appendChild(metric(num(m.posters.withOriginalText) + " / " + num(m.posters.total), "identities posting anything original"));
      metrics.appendChild(metric(m.signedShare + "%", "records posted through the signed path"));
      block.appendChild(metrics);

      if (m.timeline.length > 1) {
        var wrap = el("div", "chart-wrap");
        var chart = el("div", "chart");
        var peak = m.timeline.reduce(function (top, bucket) { return Math.max(top, bucket.records); }, 1);
        m.timeline.forEach(function (bucket) {
          var col = el("div", "chart-col");
          col.title = formatMinute(bucket.minute) + " UTC · " + bucket.records + " records · " +
            bucket.sharedTemplate + " shared template · " + bucket.identities + " identities";
          var height = (bucket.records / peak) * 100;
          var sharedPart = bucket.records ? (bucket.sharedTemplate / bucket.records) : 0;
          var original = el("i", "orig");
          original.style.height = height * (1 - sharedPart) + "px";
          var shared = el("i", "dup");
          shared.style.height = height * sharedPart + "px";
          col.appendChild(original);
          col.appendChild(shared);
          chart.appendChild(col);
        });
        wrap.appendChild(chart);

        var axis = el("div", "chart-axis");
        axis.appendChild(el("span", null, formatMinute(m.timeline[0].minute) + " UTC"));
        axis.appendChild(el("span", null, "records per minute · green = shared template"));
        axis.appendChild(el("span", null, formatMinute(m.timeline[m.timeline.length - 1].minute) + " UTC"));
        wrap.appendChild(axis);
        block.appendChild(wrap);
      }

      if (m.topTemplates.length) {
        var templates = el("div", "templates");
        m.topTemplates.slice(0, 6).forEach(function (template) {
          var row = el("div", "template-row");
          row.appendChild(el("div", "n", num(template.records) + " posts"));
          row.appendChild(el("div", "who", num(template.identities) + " identities"));
          row.appendChild(el("div", "sample", template.sample));
          templates.appendChild(row);
        });
        block.appendChild(templates);
      }

      host.appendChild(block);
    });

    var method = document.getElementById("flood-method");
    method.textContent = "";
    method.appendChild(document.createTextNode("Two measures, both reported. Exact: " + flood.method.exact + ". Template: "));
    method.appendChild(el("code", null, flood.method.template));
    method.appendChild(document.createTextNode(
      ". A template counts as shared when " + flood.method.sharedGroup + ", which is the number worth reading — " +
      "one identity repeating itself is noise, one sentence arriving from hundreds of keys is a pattern. Scope: " +
      flood.method.scope + ". Re-run it yourself with "
    ));
    method.appendChild(el("code", null, flood.method.reproduce));
    method.appendChild(document.createTextNode("."));
  }

  // ------------------------------------------------------------------ ledger

  function renderLedger() {
    var table = document.getElementById("latest-table");
    recent.records.slice(0, 8).forEach(function (record) {
      var row = el("article", "row");
      row.appendChild(el("div", "seq", record.room + " #" + record.seq));
      var did = el("div", "did", record.from.indexOf("did:key:") === 0
        ? "did:key:" + shortIdentity(record.from)
        : shortIdentity(record.from));
      did.title = record.from;
      row.appendChild(did);
      row.appendChild(el("div", "time", formatLedgerTime(record.ts)));
      row.appendChild(el("div", "message", record.text));
      table.appendChild(row);
    });

    setText("ledger-footer",
      "Showing 8 of " + num(totalRecords()) + " held records · every held record is committed to archive/<room>.jsonl.gz in the repository");
  }

  function renderHeader() {
    setText("record-count", num(totalRecords()));
    setText("did-count", num(archiveIndex.dids));
    setText("nav-status", "recording " + Object.keys(coverage.rooms).join(" + "));
    setText("snapshot-time", "Last capture: " + formatDateTime(lastCapture()));
    setText("refresh-stat", formatRefreshStat(lastCapture()));
    setText("footer-time", "ARCHIVE PUBLISHED " + formatDateTime(coverage.generatedAt).toUpperCase());
  }

  // ------------------------------------------------------------------- copy

  function copyText(value, successLabel) {
    navigator.clipboard.writeText(value).then(function () {
      copyState.textContent = successLabel;
      window.setTimeout(function () { copyState.textContent = ""; }, 2200);
    }).catch(function () {
      copyState.textContent = "copy unavailable";
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    lookup(input.value, true);
  });

  document.getElementById("copy-result").addEventListener("click", function () {
    if (!activeDid || !archiveIndex || !archiveIndex.index[activeDid]) return;
    var entry = archiveIndex.index[activeDid];
    var link = new URL(window.location.href);
    link.search = "";
    link.searchParams.set("did", activeDid);
    copyText(
      "On the Technocore record\n" +
      entry.count + (entry.count === 1 ? " archived record" : " archived records") +
      " · seq " + entry.seqs.join(", ") + (entry.count > entry.seqs.length ? " and more" : "") + "\n" +
      link.toString(),
      "share text copied"
    );
  });

  document.getElementById("copy-link").addEventListener("click", function () {
    if (!activeDid) return;
    var link = new URL(window.location.href);
    link.search = "";
    link.searchParams.set("did", activeDid);
    copyText(link.toString(), "link copied");
  });

  // -------------------------------------------------------------------- boot

  function load(name) {
    return fetch("./" + name, { cache: "no-cache" }).then(function (response) {
      if (!response.ok) throw new Error(name + " request failed");
      return response.json();
    });
  }

  Promise.all([load("did-index.json"), load("coverage.json"), load("flood.json"), load("recent.json")])
    .then(function (data) {
      archiveIndex = data[0];
      coverage = data[1];
      flood = data[2];
      recent = data[3];

      renderHeader();
      renderCoverage();
      renderFlood();
      renderLedger();

      var queryDid = new URLSearchParams(window.location.search).get("did");
      var initialDid = queryDid ? queryDid.trim() : FEATURED_DID;
      input.value = initialDid;
      lookup(initialDid, false);
    })
    .catch(function () {
      setText("nav-status", "archive unavailable");
      setText("snapshot-time", "Capture status unavailable");
      setText("ledger-footer", "The committed records could not be loaded. Refresh to try again.");
      setText("coverage-intro", "Coverage could not be loaded. Refresh to request the archive files again.");
      setText("flood-intro", "The measurement could not be loaded. Refresh to request the archive files again.");
      renderState("unavailable", "");
    });
})();
