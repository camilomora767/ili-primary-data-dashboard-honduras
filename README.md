# ILI Honduras — Primary Data Collection Dashboard

Honduras dashboard for the MIT Center for Transportation & Logistics — Informal Logistics Initiative, adapted from the Mexico dashboard.

Includes field-observation monitoring, observer progress, device-GPS mapping, question summaries, duration distributions, courier ObservationID coverage, and Excel/photo ZIP downloads.


## Excel downloads

Both instruments download only as genuine `.xlsx` workbooks:

- **Sheet0:** native Qualtrics variable names in row 1, full question/field labels in row 2, and completed responses from row 3. Column order, blank columns, duplicate variable names, accents, and comma-separated answers are preserved. Cell line breaks use Excel's LF convention. The first two rows are frozen.
- **Data dictionary:** column position, Excel letter, variable, full question/field label, ImportId, and Excel type. Position and ImportId distinguish duplicate variable names.

The column structure is read from each Honduras survey's native export at download time. Numeric text-entry fields and upload sizes become Excel numbers only when the active Honduras question metadata identifies them. Codes, identifiers and other text remain literal strings; unavailable metadata falls back to text.

The observation and courier buttons download all completed responses, independent of dashboard filters. Blank and false Finished values remain excluded. The displayed-observer summary also downloads as Excel. The browser verifies the instrument workbook MIME type and ZIP signature before saving; legacy format query strings also return XLSX. Photo downloads use verified, bounded ZIP parts as described below.

To activate, merge the reviewed pull request and wait for the existing Vercel integration to deploy the commit. Preserve all directories when copying source manually. No respondent records or credentials are included. Tests reopen workbooks generated from synthetic schemas and responses, including repeated headers, long labels, Spanish text and punctuation.

## Vehicle-photo ZIP downloads

Click **Download images** to prepare the photo list, then **Download all parts** or an individual part. Each ZIP contains at most 50 photos and is capped at 64 MiB. Parts that exceed the size or preparation-time budget are split automatically; **Make smaller ZIPs** is also available.

Extract every part into the same destination folder. These are complete ZIP archives, not pieces that need to be joined. Each includes a uniquely named `photo_manifest_part-ID.csv` with the response ID, original filename, and saved path. Short, Windows-safe paths avoid filename and extraction-path problems.

The page verifies the byte count, SHA-256 checksum, closing ZIP record, directory and expected entry count before offering a file to save. A missing or interrupted photo fails that part before ZIP headers are sent. Completed parts are finalized before delivery and streamed with backpressure; JPEGs are stored without recompression. A failed transfer is rejected, rather than saved as a corrupt ZIP.

Use **Retry** for one part. **Stop** cancels the current transfer; **Resume remaining parts** skips completed parts while the page stays open. The browser may ask to allow multiple downloads. Individual download buttons remain available, including **Download again**. The photo snapshot expires after four hours; **Refresh list** prepares a new snapshot and resets progress.

After deploying this change, reload the dashboard before downloading images. Existing incomplete ZIPs should be downloaded again using the new parts. No new credentials or storage services are required; the existing public access and Honduras survey configuration remain in effect.

### Photo-download validation

`npm test` checks archives, browser integrity checks, cancellation, retry/splitting, public access, and Excel regressions with synthetic data. Run `node tests/photo-scale.mjs` for the independent Python extraction check: 1,663 synthetic 640-KiB photos (over 1 GiB) across bounded archives. Python 3 must be available as `python3` (or `python` on Windows); set `PHOTO_ZIP_PYTHON` to an executable path if needed. Generated ZIPs are validated then removed; local reports are excluded from Git.

## Honduras instruments

- Observations: https://mit.co1.qualtrics.com/jfe/form/SV_9LXy32LyJuSlvgi
- Courier survey: https://mit.co1.qualtrics.com/jfe/form/SV_8e48NZfmjF2fFrM

These survey IDs are the server defaults in `lib/config.js`. No responses or API tokens are included.

## Vercel setup

1. Import this GitHub repository into a new Vercel project.
2. Use Framework Preset **Other**, root directory `./`, and default install/build/output settings.
3. Set these variables in Vercel **Project → Settings → Environment Variables** for Production, then redeploy:

| Variable | Value |
| --- | --- |
| `QUALTRICS_API_TOKEN` | Your Qualtrics API token, entered directly in Vercel |
| `QUALTRICS_DATA_CENTER` | Your account's API data center; template default is `iad1` |
| `QUALTRICS_SURVEY_ID` | `SV_9LXy32LyJuSlvgi` |
| `QUALTRICS_COURIER_SURVEY_ID` | `SV_8e48NZfmjF2fFrM` |

The dashboard and its data/download endpoints are public. Configure Preview too if preview deployments use live data. Use `.env.example` as a checklist; never commit real credentials.

After deployment, verify `/api/data` and `/api/courier-summary` return JSON. Live Honduras exports have not been tested without API credentials.

## Verify the Honduras fields

The following question IDs come from the Mexico template; the Honduras survey definition has not yet been inspected. Override them in Vercel if necessary:

| Field | Default | Optional variable |
| --- | --- | --- |
| Operation | `QID27` | `QUALTRICS_OPERATION_QUESTION_ID` |
| Vehicle | `QID8` | `QUALTRICS_VEHICLE_QUESTION_ID` |
| Vehicle photo | `QID17` | `QUALTRICS_PHOTO_QUESTION_ID` |

Observers use `RecipientEmail`, with `ExternalReference` as an additional filter. Device GPS is read from `__js_GPS_Latitude` / `__js_GPS_Longitude` or `GPS_Latitude` / `GPS_Longitude`; IP-derived Qualtrics location is not counted as device GPS. Question labels and choices come from the active Qualtrics survey.

Duration is `EndDate − StartDate`, with values over 30 minutes excluded from its median/distribution. Interpret this as delivery dwell time only if the observation workflow spans the delivery. Dates are displayed and filtered as recorded in the Qualtrics export, without timezone conversion; configure the reporting timezone consistently for the Honduras team.

The map source is capped at the last 4,000 filtered records; the table shows the most recent 100 of those. Excel data and photo downloads include all completed records, independent of dashboard filters.

## Courier linkage

In the observation instrument's final courier link/QR, use:

```text
https://mit.co1.qualtrics.com/jfe/form/SV_8e48NZfmjF2fFrM?ObservationID=${e://Field/ResponseID?format=urlencode}
```

Declare `ObservationID` as Embedded Data in the courier survey and retain the URL value. Update both the QR destination and visible hyperlink in Qualtrics if necessary. This repository does not modify the Qualtrics instruments.

Courier coverage counts nonempty `ObservationID` values; it does not verify matches to completed observation responses.

## Development

Requires Node.js 20 or newer.

```sh
npm install
npm test
npx vercel dev
```

The UI uses Chart.js and Leaflet from their CDNs. Vercel hosts the `api/` handlers; `archiver` generates photo ZIP files and `exceljs` generates Excel workbooks. Preserve the `api/`, `lib/`, and `assets/` directories.
