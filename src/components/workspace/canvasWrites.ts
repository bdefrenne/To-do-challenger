/**
 * Shared timings for anything that WRITES to Liveblocks storage from the canvas.
 *
 * Storage updates are metered (one billed row update per node per write, from
 * every client that makes one), and the canvas has several places where a write
 * is triggered by something that fires at frame rate — a drag, a card growing,
 * a keystroke. TD2-185: the drag path alone was ~2,000-4,000 updates per second
 * and burned a 3,000,000/month allowance in minutes of use.
 *
 * The rule this file exists to hold: never write storage from a continuous
 * gesture. Either publish it through presence and commit once at the end (the
 * drag path), or debounce to the value it settles at (the constants below).
 */

/** Wait for a measured height to settle before mirroring it into `node.height`.
 *  Long enough to swallow the intermediate frames of a card growing by a row,
 *  short enough that a peer still reads the resize as one step. */
export const HEIGHT_COMMIT_MS = 200;

/* A text card's `content` is still written per keystroke, deliberately. The
 * textarea is controlled directly off `node.content`, so deferring the write
 * means holding a local draft and reconciling it against incoming remote edits —
 * the exact shape that produced TD-62 (live text edits reverted). Text nodes are
 * also a rounding error next to a drag: a 500-character note costs 500 updates,
 * where one tray-column drag cost ~70,000. Not worth the risk until it shows up
 * in the numbers. */
