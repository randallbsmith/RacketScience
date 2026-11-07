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
};
const NOTES_CELL  = "B33";  // team notes cell ("" = no team notes); cleared by clearEntriesApp()

// A row counts as an active player when its email column contains "@"
// (the same rule clearEntries() uses).

function doGet(e) {
  const p = (e && e.parameter) || {};
  let result;
  try {
    if (!p.action || p.action === "read") result = readState();
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

function readState() {
  const sh = sheet_();
  const width = Math.max.apply(null, Object.values(COL));
  const rows = sh.getRange(FIRST_ROW, 1, LAST_ROW - FIRST_ROW + 1, width).getValues();
  const players = [];
  rows.forEach((r, i) => {
    const email = String(r[COL.email - 1] || "");
    if (!email.includes("@")) return;
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
      return { ok: true };
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

function conflict_() {
  return { ok: false, conflict: true, message: "Someone else changed this at the same time. Reload to review." };
}
