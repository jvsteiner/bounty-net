# Bounty-Net Architecture Evolution Plan

## Overview

Refactor bounty-net to use a daemon-centric architecture with proper SQLite handling.

## Current Problems

1. **sql.js in-memory caching** - Multiple processes (daemon + MCP server) have separate in-memory copies of the database, causing data races and inconsistencies
2. **MCP server runs independently** - Can conflict with daemon, fetches stale NOSTR data
3. **UI is maintainer-only** - Reporters have no visibility into their submitted reports

## Target Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Daemon                              │
│  - Owns SQLite database (better-sqlite3)                │
│  - Handles all NOSTR communication                      │
│  - Serves UI on localhost:1976                          │
│  - Exposes IPC socket for MCP server                    │
└─────────────────────────────────────────────────────────┘
        │                           │
        │ IPC                       │ HTTP
        ▼                           ▼
┌───────────────┐           ┌───────────────┐
│  MCP Server   │           │   Browser UI  │
│  (stateless)  │           │  (two tabs)   │
│               │           │               │
│ All ops go    │           │ - Outbound    │
│ through IPC   │           │   (reporter)  │
│ to daemon     │           │ - Inbound     │
│               │           │   (maintainer)│
└───────────────┘           └───────────────┘
```

## Changes

### Phase 1: Replace sql.js with better-sqlite3

**Files affected:**
- `src/storage/database.ts` - Replace sql.js with better-sqlite3
- `package.json` - Swap dependency

**Changes:**
- Remove sql.js, add better-sqlite3
- Remove in-memory caching - all reads/writes go directly to disk
- Enable WAL mode for concurrent access
- Remove `DatabaseWrapper.save()` calls (no longer needed)
- Simplify `initializeDatabase()` - just open file, run migrations

### Phase 2: MCP Server Becomes Stateless IPC Client

**Files affected:**
- `src/server/index.ts` - Remove database initialization, use IPC only
- `src/server/backfill.ts` - Delete (no longer needed)
- `src/tools/reporter/index.ts` - Route all operations through daemon IPC
- `src/tools/maintainer/index.ts` - Already uses IPC, verify all ops go through daemon
- `src/tools/shared/index.ts` - Route through daemon IPC
- `src/types/ipc.ts` - Add new IPC commands for reporter operations

**New IPC commands:**
- `report_bug` - Submit a bug report (currently done directly in MCP server)
- `get_report_status` - Check status of a submitted report
- `list_my_reports` - List reports submitted by this identity
- `get_balance` - Get wallet balance
- `resolve_maintainer` - Resolve maintainer pubkey

**Remove from MCP server:**
- Direct database access
- Direct NOSTR client access
- Backfill logic

### Phase 3: Two-Tab UI

**Files affected:**
- `src/ui/views/index.ts` - Add tab navigation, outbound view
- `src/ui/server.ts` - Add routes for outbound reports

**Outbound tab (Reporter view):**
- List of reports I've submitted
- Status of each (pending, accepted, rejected)
- Responses received
- Deposit/reward info

**Inbound tab (Maintainer view):**
- Current functionality (list received reports)
- Accept/reject actions
- Archive functionality

**UI structure:**
```
┌─────────────────────────────────────────────┐
│  [Outbound]  [Inbound]           Bounty-Net │
├─────────────────────────────────────────────┤
│                                             │
│  (tab content)                              │
│                                             │
└─────────────────────────────────────────────┘
```

### Phase 4: Daemon Required for All Operations

**Files affected:**
- `src/server/index.ts` - Fail if daemon not running
- `src/cli.ts` - Update help text
- `README.md` - Update documentation

**Changes:**
- MCP server refuses to start if daemon not running
- Clear error message: "Daemon required. Run: bounty-net daemon start"
- Remove reporter-only mode logic

### Phase 5: Clean Up NOSTR Sync

**Files affected:**
- `src/daemon/sync.ts` - Already updated to use NOW as default
- `src/daemon/index.ts` - Ensure high water mark is persisted properly

**Ensure:**
- Fresh install starts from NOW (no historical fetch)
- High water mark advances as reports are processed
- Duplicate detection is reliable

## Migration Path

1. **Phase 1 first** - Database change is foundational
2. **Phase 2 next** - MCP server simplification depends on stable database
3. **Phase 3** - UI can be done in parallel with Phase 2
4. **Phase 4** - Final cleanup after Phases 2 & 3
5. **Phase 5** - Polish sync behavior

## Testing

After each phase:
1. Delete `~/.bounty-net/bounty-net.db`
2. Start daemon
3. Verify fresh database created
4. Submit test report
5. Verify report appears in UI
6. Accept/reject report
7. Verify status updates correctly
8. Restart daemon
9. Verify data persists

## Rollback

If issues arise:
- Phase 1: Revert to sql.js (keep both deps temporarily)
- Phase 2-4: IPC changes are additive, can fall back to direct DB access
