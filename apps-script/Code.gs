// ============================================================
//  Racket Science! — Apps Script web app for the GitHub Pages page
//
//  Paste this whole file into the sheet's Apps Script editor
//  (Extensions → Apps Script), replacing the old web-app code.
//  Your other scripts (sendEmail, updateDate, clearEntries) can stay.
//
//  Deploy → Manage deployments → ✏️ Edit → Version: New version
//    Execute as:      Me
//    Who has access:  Anyone        ← required; otherwise players
//                                     are sent to a Google sign-in
//  Editing the existing deployment keeps the same /exec URL.
// ============================================================

// ---- Sheet layout (1 = column A) — check these against your sheet ----
const SHEET_NAME  = "RacketScienceAppData";
const DATE_CELL   = "C1";
const FIRST_ROW   = 3;
const LAST_ROW    = 31;
const COL = {
  name:           2,  // B
  yes:            3,  // C  checkbox
  no:             4,  // D  checkbox
  maybe:          5,  // E  checkbox
  comments:       6,  // F
  email:          7,  // G
  alternateEmail: 8,  // H
  phone:          9,  // I  — set to 0 if the sheet has no phone column
  devices:       10,  // J  "deviceId:taps" entries; maintained by the page's row guard
};
const DEVICE_CLAIM = 3;     // taps on a row before a device "owns" it (the page then asks before editing other rows)
const NOTES_CELL  = "B33";  // team notes cell ("" = no team notes); cleared by clearEntriesApp()

// A row counts as an active player when its email column contains "@"
// (the same rule clearEntries() uses).

function doGet(e) {
  const p = (e && e.parameter) || {};
  let result;
  try {
    if (!p.action || p.action === "read") result = readState(p);
    else if (p.action === "update") result = updateField(p);
    else result = { ok: false, message: "Unknown action." };
  } catch (err) {
    result = { ok: false, message: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
}

function gameDate_(sh) {
  const v = sh.getRange(DATE_CELL).getValue();
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  return String(v);
}

// ---- Devices column: "a1b2c3d4:5, 9f8e7d6c:2" = device a1b2c3d4 tapped this row 5 times ----
// Delete an entry to reset that device for the row; set its number to 3+ to make it own the row.
const DEVICE_ID = /^[a-z0-9]{8}$/;
function parseDevices_(text) {
  const m = {};
  String(text || "").split(/[,\s]+/).forEach(t => {
    const [id, n] = t.split(":");
    if (DEVICE_ID.test(id || "")) m[id] = parseInt(n, 10) || 0;
  });
  return m;
}
function formatDevices_(m) {
  return Object.keys(m).map(id => id + ":" + m[id]).join(", ");
}
function ensureDevicesColumn_(sh) {
  if (sh.getMaxColumns() < COL.devices) sh.insertColumnsAfter(sh.getMaxColumns(), COL.devices - sh.getMaxColumns());
  const head = sh.getRange(FIRST_ROW - 1, COL.devices);
  if (!head.getValue()) head.setValue("devices (used by the web page; don't edit unless resetting)");
}

function readState(p) {
  const sh = sheet_();
  const width = Math.min(Math.max.apply(null, Object.values(COL)), sh.getMaxColumns());
  const rows = sh.getRange(FIRST_ROW, 1, LAST_ROW - FIRST_ROW + 1, width).getValues();
  const device = DEVICE_ID.test((p && p.device) || "") ? p.device : "";
  const players = [], mine = [];
  rows.forEach((r, i) => {
    const email = String(r[COL.email - 1] || "");
    if (!email.includes("@")) return;
    if (device && (parseDevices_(r[COL.devices - 1])[device] || 0) >= DEVICE_CLAIM) mine.push(String(FIRST_ROW + i));
    players.push({
      id: String(FIRST_ROW + i),
      name: String(r[COL.name - 1] || ""),
      attendance: r[COL.yes - 1] === true ? "yes" : r[COL.no - 1] === true ? "no"
                : r[COL.maybe - 1] === true ? "maybe" : null,
      comments: String(r[COL.comments - 1] || ""),
      // Emails and phones are deliberately NOT returned: this web app is public.
      // They live in the sign-in-protected contacts sheet instead.
    });
  });
  return {
    ok: true,
    gameDate: gameDate_(sh),
    notes: NOTES_CELL ? String(sh.getRange(NOTES_CELL).getValue() || "") : null,
    players: players,
    mine: mine,   // only this device's own rows; the device list itself stays private
  };
}

const TEXT_FIELDS = ["name", "comments"];  // the only text fields the public page may change

function updateField(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_();
    if (p.gameDate && p.gameDate !== gameDate_(sh)) {
      return { ok: false, conflict: true, message: "The game date has changed. Reload to see the new game." };
    }

    if (p.field === "notes") {
      if (!NOTES_CELL) return { ok: false, message: "Team notes are not set up." };
      const cell = sh.getRange(NOTES_CELL);
      if (String(cell.getValue() || "") !== (p.previous || "")) return conflict_();
      cell.setValue(p.value || "");
      return { ok: true };
    }

    const row = parseInt(p.playerId, 10);
    if (!(row >= FIRST_ROW && row <= LAST_ROW)) return { ok: false, message: "Unknown player." };

    if (p.field === "attendance") {
      const boxes = sh.getRange(row, COL.yes, 1, 3);
      const [y, n, m] = boxes.getValues()[0];
      const current = y === true ? "yes" : n === true ? "no" : m === true ? "maybe" : "";
      if (current !== (p.previous || "")) return conflict_();
      const v = p.value || "";
      if (!["", "yes", "no", "maybe"].includes(v)) return { ok: false, message: "Bad value." };
      boxes.setValues([[v === "yes", v === "no", v === "maybe"]]);
      return { ok: true, mine: countDevice_(sh, row, p) };
    }

    if (TEXT_FIELDS.includes(p.field) && COL[p.field]) {
      const cell = sh.getRange(row, COL[p.field]);
      if (String(cell.getValue() || "") !== (p.previous || "")) return conflict_();
      cell.setValue(String(p.value || "").slice(0, 500));
      return { ok: true };
    }
    return { ok: false, message: "Unknown field." };
  } finally {
    lock.releaseLock();
  }
}

// Record a device's tap on a row: count=1 adds one tap, claim=1 makes it the owner at once ("Always").
function countDevice_(sh, row, p) {
  if (!DEVICE_ID.test(p.device || "") || !(p.count || p.claim)) return undefined;
  ensureDevicesColumn_(sh);
  const cell = sh.getRange(row, COL.devices);
  const m = parseDevices_(cell.getValue());
  m[p.device] = p.claim ? Math.max(m[p.device] || 0, DEVICE_CLAIM) : (m[p.device] || 0) + 1;
  cell.setValue(formatDevices_(m));
  return m[p.device] >= DEVICE_CLAIM;
}

function conflict_() {
  return { ok: false, conflict: true, message: "Someone else changed this at the same time. Reload to review." };
}
