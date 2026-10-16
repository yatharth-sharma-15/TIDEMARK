# Design notes: the four hard questions

## 1. Is a site outage or a CAPTCHA a change?

No. A page version is only stored when the page **rendered successfully and its readable text changed**.

`classifyResponse()` in `src/checker.js` sorts every load into one of three outcomes before any diffing happens:

| What the site returned | Outcome | What Tidemark does |
| --- | --- | --- |
| 5xx, no response, timeout | `error` (outage) | Retry 30 s, 2 min, 10 min. Then back off 2x, 4x, 8x, 16x (max 24 h). No version saved. |
| 429, 401/403, CAPTCHA wording or markup on a short page | `blocked` | 429 honours `Retry-After`. Others are not retried within the cycle. No version saved. |
| 404/410 | `error` | Reported, not retried within the cycle. |
| 200 with readable text | normal | Diff against the last version. |

One notice is sent after **3 failed cycles in a row** ("looks unreachable" or "is blocking checks"), and one "is back" notice on recovery. A page that comes back nearly empty (a half-rendered load) is treated as a failed check, not as "everything was deleted".
CAPTCHA markers only count on short pages (under 2,500 characters of text), so a contact page that embeds reCAPTCHA is not mistaken for a block.

## 2. 200 users watch the same URL. Is it fetched 200 times?

No. The scheduler claims one due job and then every other due job **with the same URL** (`claimGroup()` in `src/worker.js`). The page is rendered once, and each monitor applies its own selectors, sensitivity and keywords to that one HTML document. A second reload (used to learn rotating content) is also shared. Cost: 1 to 2 loads, not 200.

Related protections: a per-host slot reservation (default one request per host every 10 s), `robots.txt` is honoured, and check times are jittered by +/-10% so monitors created together do not fire together.

## 3. How are endless alerts on "different on every load" pages avoided?

Four layers, cheapest first:

1. **Normalisation.** Timestamps, relative times ("5 min ago"), counters ("1,204 views"), copyright years, UUIDs and long random tokens become placeholders before hashing. Scripts, styles, hidden elements, ads, cookie banners and carousels are removed from the DOM.
2. **Instability learning.** When a change is suspected, the page is reloaded a few seconds later. Lines that differ between two back-to-back loads are rotating content; they are remembered per monitor and excluded from comparison. The baseline snapshot is stabilised the same way.
3. **Regions.** The visual picker saves CSS selectors to watch or ignore, which removes whole noisy areas.
4. **Flap breaker.** Five or more versions in six hours marks the monitor `noisy`: alerts pause, the user gets one explanation, and the dashboard says how to fix it.

Sensitivity then decides how large a remaining change must be: **High** = any text change, **Medium** = a real text edit (the default), **Low** = 4+ changed lines or 10% of the page.

## 4. How is a site not hammered with requests?

* Minimum interval is 15 minutes.
* Identical URLs share one load (question 2).
* One request slot per host every `DOMAIN_MIN_GAP_MS` (default 10 s); if a host's queue is longer than 45 s, jobs are put back instead of holding a worker.
* Global concurrency cap (`WORKER_CONCURRENCY`).
* `robots.txt` is checked (cached 1 h) and respected.
* Failures back off exponentially up to 24 h; `Retry-After` is honoured.
* Media requests are blocked, animations are disabled, screenshots are capped at 6,000 px tall.
* Per-owner monitor cap and per-IP API rate limits.

## Public pages only, no stored credentials

URLs with a username/password are rejected. Nothing in the data model can hold a login. Every URL **and every sub-request the browser makes** is DNS-resolved and refused if it points at a private, loopback or link-local address (`src/ssrf.js`), so the service cannot be pointed at internal networks.

## Known limits

* Accounts are anonymous workspace keys stored in the browser (shareable between devices). Add real auth before opening this to the public.
* Screenshot diffs compare whole pages; ignored regions are removed from the *text* comparison only.
* If a page rotates between exactly two values and both appear in the two back-to-back loads, one version may slip through. The flap breaker catches the repeat.
* Number tracking with charts and a browser extension (bonus items) are not built.
