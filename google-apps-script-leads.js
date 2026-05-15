// Wiser Resources — Lead Capture Script
// ────────────────────────────────────────
// SETUP (one-time, takes ~3 minutes):
// 1. Open your Google Sheet
// 2. Extensions > Apps Script → paste this entire file → Save (Ctrl+S)
// 3. Click Deploy > New deployment
//    - Type: Web app
//    - Execute as: Me
//    - Who has access: Anyone
//    → Click Deploy, copy the URL
// 4. Paste that URL into investor-dna.html where it says APPS_SCRIPT_URL_HERE

const SHEET_NAME = "Leads";

function doPost(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);

    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow([
        "Timestamp", "Name", "Email", "Phone",
        "Persona", "Equity %", "Debt %", "Gold %", "Quiz Score"
      ]);
      sheet.setFrozenRows(1);
      sheet.getRange("1:1").setFontWeight("bold");
    }

    const data = JSON.parse(e.postData.contents);

    sheet.appendRow([
      new Date(),
      data.name  || "",
      data.email || "",
      data.phone || "",
      data.persona || "",
      data.equity  != null ? data.equity  : "",
      data.debt    != null ? data.debt    : "",
      data.gold    != null ? data.gold    : "",
      data.score   != null ? data.score   : "",
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Handles browser preflight / health check
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: "Wiser Resources lead capture active" }))
    .setMimeType(ContentService.MimeType.JSON);
}
