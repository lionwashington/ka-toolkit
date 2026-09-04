# Multi-attachment inbound batching

## Contract

One owner action containing several related images must become one channel
delivery, one runtime turn, and one streamed reply. Attachment order is stable.
Legacy single-attachment consumers continue to receive `attachment_path` and
`attachment_kind`; batch-aware consumers also receive `attachment_count` and
ordered `attachment_N_*` metadata. Codex receives the same ordered set as
multiple `localImage` items in one `turn/start` request.

## Telegram

Telegram media messages with the same `chat_id` and `media_group_id` form an
exact album. The daemon persists the pending update references, advances its
offset, and resets a one-second trailing timer for each member. A flush downloads
the members concurrently, preserves update order, and dispatches once. Pending
groups are rescheduled on daemon startup. Messages without `media_group_id`
retain the immediate legacy path. A later standalone message or different album
is an exact boundary and flushes the older group first, preserving input order.

## Lark

The current polling interface exposes no album identifier. The daemon therefore
uses a conservative burst rule: image-only messages must have the same chat,
sender, thread scope, minute timestamp, and consecutive non-zero
`message_position` values.
A trailing image burst is persisted for one additional poll. The next poll
either joins compatible leading images or flushes the carry. Text, sender,
timestamp, position gaps, and routing boundaries end a burst. This adds at most
one poll interval to a standalone Lark image while avoiding speculative merging
across unrelated requests.

## Failure behavior

- A failed member download does not discard successfully downloaded siblings.
- A member that arrives after its group's flush has started remains pending and
  is delivered in the next ordered turn instead of being removed with the
  in-flight snapshot.
- Stable platform/message identifiers become the batch id and dedup evidence.
- Platform cursor/watermark changes and pending batches are written to private
  daemon state; no credentials enter batch metadata or logs.
- Models receive only the exact downloaded paths named by the delivery and must
  not enumerate a shared attachment directory.
- Delivery is intentionally at-least-once across the narrow crash window between
  downstream acceptance and clearing the pending state. A stable `batch_id`
  makes a rare replay diagnosable; preferring replay avoids silent image loss.

## Observability

`/api/status` exposes `pending_attachment_batches`. A healthy idle daemon reports
zero. Telegram logs a count-only `media group flush` event; Lark logs a count-only
`image batch flush` event. Neither log entry includes captions, file paths, or
credentials.

## Regression coverage

- Exact Telegram albums, including members returned in separate polls.
- Telegram standalone images and non-image attachments retain old behavior.
- Lark same-poll and cross-poll image bursts, plus every grouping boundary.
- Restart with a persisted pending group flushes once.
- Core metadata remains all-string for MCP consumers.
- Codex creates one turn with ordered `localImage` inputs.
- Download failure, sticky routing, multi-target routing, replay, and streaming
  behavior do not regress.
