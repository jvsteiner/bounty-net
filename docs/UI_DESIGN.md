# Maintainer UI Design

> Status: Planning
> Last Updated: 2024-12-03

## Overview

A local web UI for maintainers to triage and manage incoming bug reports. Served by the daemon on `localhost:1976`.

## Rationale

- **Volume problem**: Large projects may receive hundreds of reports weekly
- **MCP tools insufficient**: Listing reports via tool output doesn't scale
- **Human-in-the-loop**: Until agents can auto-triage, maintainers need efficient UI
- **Path to automation**: UI becomes monitoring/override dashboard as agents improve

## Architecture

```
┌─────────────────────────────────────────────────┐
│                    Daemon                        │
│  ┌──────────────┐      ┌──────────────────────┐ │
│  │  IPC Server  │      │    HTTP Server       │ │
│  │  (socket)    │      │    (port 1976)       │ │
│  │              │      │                      │ │
│  │  MCP ←→ IPC  │      │  /            (UI)   │ │
│  │              │      │  /api/reports        │ │
│  │              │      │  /api/reports/:id    │ │
│  └──────────────┘      │  /api/accept/:id     │ │
│         ↓              │  /api/reject/:id     │ │
│    ┌─────────┐         └──────────────────────┘ │
│    │ SQLite  │                   ↑              │
│    │   DB    │←──────────────────┘              │
│    └─────────┘                                  │
└─────────────────────────────────────────────────┘
```

## Access

```bash
# Daemon serves UI automatically when running
bounty-net daemon start

# Open UI in default browser
bounty-net ui
# → Opens http://localhost:1976

# Or navigate directly
open http://localhost:1976
```

## Tech Stack

- **Server**: Express.js (already a dependency pattern in codebase)
- **UI**: htmx + server-rendered HTML
- **Styling**: Minimal CSS, system fonts, dark mode support
- **No build step**: Plain HTML/CSS/JS served directly

### Why htmx?

- Server-rendered = simple mental model
- No frontend build pipeline
- Partial page updates without full SPA complexity
- Perfect for CRUD operations on reports
- Tiny footprint (~14kb)

## Pages

### Dashboard (`/`)

Main triage view showing report queue.

```
┌─────────────────────────────────────────────────────────┐
│  Bounty-Net                              [Pending: 47]  │
├─────────────────────────────────────────────────────────┤
│  Filter: [All ▼] [All Repos ▼]  Search: [___________]   │
├─────────────────────────────────────────────────────────┤
│  ☐  │ Status  │ Repository        │ Summary    │ Deposit│
├─────────────────────────────────────────────────────────┤
│  ☐  │ Pending │ org/webapp        │ SQL inj... │ 100    │
│  ☐  │ Pending │ org/webapp        │ XSS in ... │ 100    │
│  ☐  │ Pending │ org/lib           │ Memory ... │ 50     │
│  ☐  │ Accepted│ org/webapp        │ Auth by... │ 100    │
├─────────────────────────────────────────────────────────┤
│  [Accept Selected]  [Reject Selected]                   │
└─────────────────────────────────────────────────────────┘
```

Features:
- Checkbox selection for batch operations
- Click row to expand/view details inline (htmx partial)
- Status filter dropdown
- Repository filter dropdown
- Sort by date, deposit, status

### Report Detail (`/reports/:id`)

Full report view (also loadable as htmx partial).

```
┌─────────────────────────────────────────────────────────┐
│  ← Back                                    Report #abc12│
├─────────────────────────────────────────────────────────┤
│  Status: Pending                         Deposit: 100 Α │
│  Repository: github.com/org/webapp                      │
│  Submitted: 2024-12-03 14:32                           │
│  Sender: abc123...def                                   │
├─────────────────────────────────────────────────────────┤
│  Files:                                                 │
│    📄 src/db/queries.ts:45-52  [Open in Zed]           │
├─────────────────────────────────────────────────────────┤
│  Description:                                           │
│  ┌─────────────────────────────────────────────────────┐│
│  │ The getUserById function constructs SQL queries     ││
│  │ using string concatenation, allowing injection...   ││
│  └─────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────┤
│  Suggested Fix:                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Use parameterized queries instead of string...      ││
│  └─────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────┤
│  [Accept & Refund]     [Reject]                        │
│  Message: [________________________________]            │
└─────────────────────────────────────────────────────────┘
```

Features:
- Full description with markdown rendering
- File links open in configured IDE
- Accept/reject with optional message
- Show response history if any

## API Endpoints

All endpoints return HTML partials for htmx, or JSON if `Accept: application/json`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Dashboard page |
| GET | `/reports` | Report list partial (htmx) |
| GET | `/reports/:id` | Report detail partial |
| POST | `/api/accept/:id` | Accept report |
| POST | `/api/reject/:id` | Reject report |
| POST | `/api/batch/accept` | Accept multiple |
| POST | `/api/batch/reject` | Reject multiple |

## IDE Deep Links

Configurable via UI or config file. Supported formats:

| IDE | URL Format |
|-----|------------|
| Zed | `zed://file/absolute/path:line` |
| VS Code | `vscode://file/absolute/path:line:column` |
| Cursor | `cursor://file/absolute/path:line:column` |
| JetBrains | `jetbrains://open?file=/path&line=N` |

Default: Auto-detect based on OS/available IDEs, or use config:

```json
{
  "ui": {
    "ideProtocol": "zed"
  }
}
```

## File Structure

```
src/ui/
├── server.ts          # Express server setup
├── routes/
│   ├── index.ts       # Dashboard route
│   ├── reports.ts     # Report routes
│   └── api.ts         # Action endpoints
├── views/
│   ├── layout.html    # Base template
│   ├── dashboard.html # Main view
│   ├── report.html    # Detail view
│   └── partials/
│       ├── report-row.html
│       └── report-detail.html
├── public/
│   ├── htmx.min.js
│   └── style.css
└── helpers/
    └── ide-links.ts   # Generate IDE deep links
```

## Security

- **Localhost only**: Server binds to `127.0.0.1`, not `0.0.0.0`
- **No auth needed**: Single user, local access only
- **CSRF**: Not critical for localhost-only, but can add tokens if needed
- **No external resources**: All assets served locally (no CDN)

## Future Enhancements

1. **Keyboard shortcuts**: `j/k` navigation, `a` accept, `r` reject
2. **Reporter reputation display**: Show sender's history
3. **Diff view**: Render suggested fixes as actual diffs
4. **Notifications**: Desktop notifications for new reports
5. **Agent mode**: Let agent auto-triage with human approval threshold
6. **Statistics**: Charts showing report volume, acceptance rate over time

## CLI Integration

```bash
# Open UI in default browser
bounty-net ui

# Show UI URL (for copying)
bounty-net ui --url
# → http://localhost:1976

# Check if UI is accessible
bounty-net ui --status
# → UI available at http://localhost:1976 (daemon running)
```

## Implementation Plan

### Phase 1: Basic UI (MVP)
- [ ] HTTP server in daemon on port 1976
- [ ] Dashboard with report list
- [ ] Report detail view
- [ ] Accept/reject single report
- [ ] `bounty-net ui` command

### Phase 2: Productivity
- [ ] Batch operations
- [ ] Filters and search
- [ ] IDE deep links
- [ ] Keyboard shortcuts

### Phase 3: Polish
- [ ] Dark mode
- [ ] Reporter history
- [ ] Statistics dashboard
- [ ] Desktop notifications
