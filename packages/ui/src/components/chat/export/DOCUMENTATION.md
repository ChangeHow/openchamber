# Ownership

This module owns per-column message selection, the export toolbar, and selected
content formatting. `MessageBody` supplies the existing image-save callback when
its menu starts selection. The shared Markdown renderer, single-message image
capture and runtime save bridges remain unchanged. Both selection modes reuse
`message/TextSelectionToolbar` for their surface, actions and mobile placement.

# Invariants

- Selection belongs to one runtime, directory, session, and chat column. Cancel
  and navigation release the selected keys and the image-save callback.
- User selections cover one visible prompt. Assistant selections cover the
  whole visible turn, including folded steps and virtualized slices. Export
  reads normalized records in transcript order and refuses missing selections.
- Reasoning and tool output stay out. Inaccessible attachment URLs become
  filenames; export never loads authenticated media.
- Each item subscribes to its own checked state. Selected items keep the same
  height as unselected items. Message controls are inert during selection;
  portaled menu clicks cannot toggle their parent message.
- The editor stays mounted and inert behind the toolbar. Cancel and Escape
  restore the draft and attachments. Empty selection disables both exports;
  success and failure retain selection for another action.
- Web, Electron and hosted mobile use the existing image download. VS Code uses
  the existing save bridge, and Capacitor uses the existing native share path.
  Markdown uses the shared clipboard helper.

# Decisions

## Why image export reuses the message's save callback

The triggering message already owns capture styles and runtime saving. Selection
passes its combined source and the live column width to that callback, even if
the triggering message has been virtualized away, so single-message exports
and native bridges need no refactor or duplicate implementation.

## Why each selected message renders separately

`buildTurnImageExportSource` already renders detached text through the shared
renderer. One segment per selected message keeps reference and footnote scopes
separate without changing the ordinary chat parser.

## Why Markdown formatting uses the existing parser

Copied Markdown joins independent messages into one document. The existing
unified/remark/GFM stack supplies source positions for isolating references and
closing unfinished fences while preserving original code and indentation.

## Why both selection modes share a toolbar

The shared toolbar keeps the same glass surface and phone safe-area placement
for text selections and message selections. On desktop export occupies the composer slot;
narrow columns and phones keep both export labels in a two-column action row.
