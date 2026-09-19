# PR 3709 validation evidence

Source HEAD: `18d7cf8cd0fe9eb49f691c3391faffb9befecbd6`. Before: upstream `614d7f76e`.

Runtime: hosted mobile in Chromium 152 on macOS, 390x844 CSS pixels with touch
emulation, plus desktop web at 1440x1000. The after UI was served from the
production `packages/web/dist` build; the before UI ran from an isolated
upstream worktree. The desktop screenshot is cropped to the Settings dialog.

The MP4 is a sampled screen capture of the live interaction, not a real iPhone
recording. Frames show multiline input, button submission, and a queued follow-up.
The keyboard check exercised Enter, Shift+Enter, Ctrl+Enter and Cmd+Enter with
`enterToSend=true` and `enterToSendConfigured=true`. No POST to session or queue
endpoints occurred before the Send button was clicked. Clicking Send produced
`prompt_async`; clicking Queue produced the queue-items POST and a visible item.

Native iOS/WKWebView and IME composition were not tested.
