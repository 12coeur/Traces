// IGC → KML — version stable basée sur le noyau minimal (drag/drop + input),
// puis ajout conversion KML et carte Leaflet sans interférer avec le chargement.

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const altSourceEl = document.getElementById("altSource");
const altModeEl = document.getElementById("altMode");
const colorEl = document.getElementById("color");
const nameEl = document.getElementById("name");
const thinEl = document.getElementById("thin");
const convertBtn = document.getElementById("convertBtn");
const downloadBtn = document.getElementById("downloadBtn");
const metaEl = document.getElementById("meta");
const statsEl = document.getElementById("stats");
const kmlPreview = document.getElementById("kmlPreview");

let current = null;       // { meta, fixes, fileName }
let lastKml = "";
let lastKmlName = "track.kml";

// ---------- 1) Noyau fiable: drag & drop + input (inchangé) ----------
["dragenter", "dragover"].forEach(ev =>
  dropzone.addEventListener(ev, e => {
    e.preventDefault();
    dropzone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach(ev =>
  dropzone.addEventListener(ev, e => {
    e.preventDefault();
    dropzone.classList.remove("drag");
  })
);
dropzone.addEventListener("drop", e => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

// Pas d’écouteur de clic sur la zone (on garde la fiabilité du label)
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) handleFile(file);
});

// ---------- 2) Lecture fichier + état UI ----------
function handleFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = String(reader.result || "");
      current = parseIGC(text);
      current.fileName = file.name.replace(/\.[^.]+$/, "");

      const n = current.fixes.length;
      metaEl.textContent = buildMetaText(current.meta, current.fileName);
      statsEl.textContent = n
        ? `✅ ${n} points, du ${formatDateUTC(current.fixes[0].time)} au ${formatDateUTC(current.fixes[n - 1].time)} (UTC)`
        : "Aucun point valide";

      convertBtn.disabled = n === 0;
      downloadBtn.disabled = true;
      kmlPreview.value = "";
      lastKml = "";
      lastKmlName = `${current.fileName || "vol"}.kml`;

      if (n) showMapTrace(current.fixes, colorEl.value);
    } catch (err) {
      console.error(err);
      metaEl.textContent = "Erreur de lecture du fichier IGC.";
      statsEl.textContent = "";
      convertBtn.disabled = true;
      downloadBtn.disabled = true;
      kmlPreview.value = "";
      lastKml = "";
    }
  };
  reader.readAsText(file);
}

// ---------- 3) Conversion KML ----------
convertBtn.addEventListener("click", () => {
  if (!current || !current.fixes?.length) return;

  const opt = {
    name: nameEl.value.trim(),
    color: colorEl.value || "#ff0055",
    altMode: altModeEl.value || "absolute",
    altSource: altSourceEl.value || "gps",
    thinEvery: Math.max(1, parseInt(thinEl.value || "1", 10))
  };

  try {
    lastKml = toKML(current, opt);
    kmlPreview.value = lastKml;
    downloadBtn.disabled = false;
    showMapTrace(current.fixes, opt.color);
  } catch (e) {
    console.error(e);
    kmlPreview.value = "Erreur lors de la génération du KML.";
    downloadBtn.disabled = true;
  }
});

// ---------- 4) Téléchargement ----------
downloadBtn.addEventListener("click", () => {
  if (!lastKml) return;
  const blob = new Blob([lastKml], { type: "application/vnd.google-earth.kml+xml" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: lastKmlName });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
});

// ---------- 5) Parsing IGC ----------
function parseIGC(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  const meta = { pilot: null, glider: null, site: null, gps: null };
  const fixes = [];

  const reDate = /^H[OF]DTE(\d{2})(\d{2})(\d{2})/;
  const rePilot = /^H[OF]PLT.*?:\s*(.+)$/;
  const reGlider = /^H[OF]GTY.*?:\s*(.+)$/;
  const reSite = /^H[OF]SIT.*?:\s*(.+)$/;
  const reGps = /^H[OF]GPS.*?:\s*(.+)$/;
  const reB = /^B(\d{2})(\d{2})(\d{2})(\d{2})(\d{5})([NS])(\d{3})(\d{5})([EW])([AV])(\d{5})(\d{5})/;

  let dateParts = null;

  for (const line of lines) {
    if (line[0] === "H") {
      if (reDate.test(line)) {
        const m = line.match(reDate);
        dateParts = { dd: +m[1], mm: +m[2], yy: +m[3] };
      } else if (rePilot.test(line)) meta.pilot = line.match(rePilot)[1].trim();
      else if (reGlider.test(line)) meta.glider = line.match(reGlider)[1].trim();
      else if (reSite.test(line)) meta.site = line.match(reSite)[1].trim();
      else if (reGps.test(line)) meta.gps = line.match(reGps)[1].trim();
      continue;
    }

    if (line[0] === "B") {
      const m = line.match(reB);
      if (!m) continue;

      const hh = +m[1], mi = +m[2], ss = +m[3];
      const lat = igcCoordToDeg(+m[4], +m[5], m[6]);
      const lon = igcCoordToDeg(+m[7], +m[8], m[9]);
      const valid = m[10] !== "V";
      const pAlt = +m[11];
      const gAlt = +m[12];

      const date = dateParts ? igcDateToISO(dateParts) : todayUTCISODate();
      const when = new Date(`${date}T${pad2(hh)}:${pad2(mi)}:${pad2(ss)}Z`);

      if (Number.isFinite(lat) && Number.isFinite(lon) && valid) {
        fixes.push({ time: when, lat, lon, pAlt, gAlt });
      }
    }
  }

  return { meta, fixes };
}

function igcCoordToDeg(deg, mmmmm, hemi) {
  const minutes = Math.floor(mmmmm / 1000) + (mmmmm % 1000) / 1000;
  let dec = deg + (minutes / 60);
  if (hemi === "S" || hemi === "W") dec = -dec;
  return dec;
}
function igcDateToISO({ dd, mm, yy }) {
  return `${2000 + yy}-${pad2(mm)}-${pad2(dd)}`;
}
function todayUTCISODate() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
const pad2 = n => String(n).padStart(2, "0");
function formatDateUTC(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

// ---------- 6) Génération KML ----------
function toKML({ meta, fixes }, opts) {
  const { name, color, altMode, altSource, thinEvery } = opts;
  const altKey = altSource === "pressure" ? "pAlt" : "gAlt";

  const coords = [];
  const when = [];

  for (let i = 0; i < fixes.length; i += thinEvery) {
    const f = fixes[i];
    const alt = Number.isFinite(f[altKey]) ? f[altKey] : 0;
    coords.push(`${f.lon.toFixed(6)},${f.lat.toFixed(6)},${alt}`);
    when.push(f.time.toISOString());
  }

  const kmlColor = cssHexToKmlABGR(color);
  const docName = name || buildAutoName(meta, fixes);
  const desc = buildDescription(meta, fixes);

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(docName)}</name>
    <description>${escapeXml(desc)}</description>
    <Style id="trackStyle">
      <LineStyle><color>${kmlColor}</color><width>3</width></LineStyle>
      <PolyStyle><color>${kmlColor}</color></PolyStyle>
    </Style>
    <Placemark>
      <name>${escapeXml(docName)}</name>
      <styleUrl>#trackStyle</styleUrl>
      <gx:Track xmlns:gx="http://www.google.com/kml/ext/2.2">
        ${when.map(w => `<when>${w}</when>`).join("\n        ")}
        ${coords.map(c => `<gx:coord>${c}</gx:coord>`).join("\n        ")}
        <altitudeMode>${altMode}</altitudeMode>
      </gx:Track>
    </Placemark>
    ${coords.length ? `<Placemark><name>Décollage</name><Point><coordinates>${coords[0]}</coordinates></Point></Placemark>` : ""}
    ${coords.length ? `<Placemark><name>Atterrissage</name><Point><coordinates>${coords[coords.length-1]}</coordinates></Point></Placemark>` : ""}
  </Document>
</kml>`;
}

function cssHexToKmlABGR(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "ff5555ff";
  const rr = m[1].slice(0, 2), gg = m[1].slice(2, 4), bb = m[1].slice(4, 6);
  return `ff${bb}${gg}${rr}`;
}
function buildAutoName(meta, fixes) {
  const date = fixes[0]?.time ? fixes[0].time.toISOString().slice(0, 10) : "vol";
  const who = meta.pilot ? ` ${meta.pilot}` : "";
  return `Vol${who} ${date}`;
}
function buildDescription(meta, fixes) {
  const parts = [];
  if (meta.pilot) parts.push(`Pilote: ${meta.pilot}`);
  if (meta.glider) parts.push(`Aile: ${meta.glider}`);
  if (meta.site) parts.push(`Site: ${meta.site}`);
  if (meta.gps) parts.push(`GPS: ${meta.gps}`);
  parts.push(`Points: ${fixes.length}`);
  if (fixes.length) {
    parts.push(`De: ${formatDateUTC(fixes[0].time)} UTC`);
    parts.push(`À: ${formatDateUTC(fixes[fixes.length - 1].time)} UTC`);
  }
  return parts.join(" • ");
}
function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function buildMetaText(meta, fileBase) {
  const items = [];
  items.push(`Fichier: ${fileBase}.igc`);
  if (meta.pilot) items.push(`Pilote: ${meta.pilot}`);
  if (meta.glider) items.push(`Aile: ${meta.glider}`);
  if (meta.site) items.push(`Site: ${meta.site}`);
  if (meta.gps) items.push(`GPS: ${meta.gps}`);
  return items.join(" • ");
}

// ---------- 7) Carte Leaflet (sécurisée) ----------
let map, lineLayer, startMarker, endMarker;

function showMapTrace(fixes, color = "#ff0055") {
  if (!fixes.length) return;
  if (typeof L === "undefined") return;

  const coords = fixes.map(f => [f.lat, f.lon]);
  const bounds = L.latLngBounds(coords);

  if (!map) {
    map = L.map("map", { zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors"
    }).addTo(map);
  }

  if (lineLayer) map.removeLayer(lineLayer);
  if (startMarker) map.removeLayer(startMarker);
  if (endMarker) map.removeLayer(endMarker);

  lineLayer = L.polyline(coords, { color, weight: 3, opacity: 0.9 }).addTo(map);
  startMarker = L.marker(coords[0]).addTo(map).bindPopup("Décollage");
  endMarker = L.marker(coords[coords.length - 1]).addTo(map).bindPopup("Atterrissage");

  map.fitBounds(bounds, { padding: [20, 20] });
  setTimeout(() => map.invalidateSize(), 0);
}
