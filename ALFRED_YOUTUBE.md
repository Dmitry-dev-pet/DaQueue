# Alfred YouTube Queue — DaQueue fork adapter

This is an independent **MIT-licensed fork** of
[DaQueue by Abhiram K](https://github.com/abhiramkunnath/DaQueue).
DaQueue's existing queue, auto-next, drag sorting, popup, SponsorBlock
behaviour, and local persistent storage remain the source of truth.

The Alfred additions are narrowly scoped:

- `manifest.json`: a distinctive name and only three additional Chrome
  permissions (`nativeMessaging`, `alarms`, `tabs`). The extension is
  restricted to YouTube, its own thumbnails, and existing SponsorBlock
  origins; **no Google account OAuth or YouTube Data API key is required**.
- `alfred-native.js`: an isolated, fixed-command native controller that calls
  DaQueue's original `getQueue`, `addVideo` and serialized `mutate`.
- `background.js`: imports and initializes the adapter. All existing DaQueue
  features remain unchanged.
- `tests/alfred-native.test.mjs`: offline search parser, queue, exact-index,
  browser-tab and command-allowlist tests.

## What Alfred can do

| Operation | How it works |
| --- | --- |
| Search | Read public YouTube search page (no cookies) and return up to 10 distinct video title/channel choices |
| Play selected search result | Navigate **one** normal YouTube tab, or open a new tab; fail when multiple eligible YouTube tabs exist |
| Add Next | Use DaQueue's existing queued-video insertion with `next=true` |
| Add to End | Use DaQueue's existing insertion with `next=false` |
| List queue | Read existing DaQueue queue; return up to 250 entries |
| Move / remove | Compare the expected row title before changing by index |
| Clear queue | Only with explicit `CLEAR_QUEUE` confirmation |

Search result video IDs remain in the extension and can only be selected
within a short-lived indexed search session (2-minute TTL). A native host
cannot send arbitrary commands, URLs, cookies, page JS, shell text, or
unbounded search/download requests.

**Search limitation:** YouTube's public results page includes an internal
`ytInitialData` object. This parser is necessarily best effort; YouTube can
change the format, display a consent/challenge page, or send localized results.
If parsing fails, the bridge returns `SEARCH_UNAVAILABLE` and never invents
a video. Title and channel metadata are untrusted source data; users should
choose the actual result. Searches do not use the signed-in Chrome cookies.

**Playback limitation:** Clicking Play requests navigation to the selected
video; YouTube/Chrome may subsequently block autoplay. This initial
adapter does not claim to have verified actual playback unless a separate
readback test is implemented. Queue additions are verified against DaQueue
storage, not against YouTube's built-in miniplayer queue. Do not combine
those two queues.

## Local Mac installation — not deployed yet

1. Create a clone of the **fork feature branch**, not upstream `main`.
2. Check `node --test tests/alfred-native.test.mjs` and
   `node --check background.js`.
3. Visit `chrome://extensions` → Developer mode → Load unpacked, and
   select the fork checkout. Note the installed extension ID.
4. The companion private MCP/Native Messaging host will be created in
   `Dmitry-dev-pet/infra-mcp-gateway` **as a separate video queue service**,
   with its own host name, socket and exact extension ID. Do not register
   the existing Music Companion host for this extension.
5. Run read-only queue/search acceptance first, then one operator-approved
   Play and Add Next. Do not modify the Music Companion extension or its
   existing Secure MCP Tunnel.

**Status:** Source-only until tests and physical owner Mac checks succeed.
Neither a video MCP, local Native Messaging host, nor remote ChatGPT video
plugin is proven connected just by GitHub CI.

Retain `LICENSE` and upstream author's copyright notices in any
redistribution. This is not an official DaQueue release.
