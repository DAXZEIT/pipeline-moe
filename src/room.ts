// The Room: shared transcript + serial turn queue + @mention routing + work
// receipts. One room per process. All model work is serialised here, which
// also matches llama-server running with --parallel 1.
//
// Implementation lives in src/room/ as a layered inheritance chain
// (RoomCore → RoomSettings → RoomGoals → RoomRouting → RoomConversations →
// RoomSlash) so a single object still carries every field at runtime.

import { RoomSlash } from "./room/room-slash.js"

export class Room extends RoomSlash {}
