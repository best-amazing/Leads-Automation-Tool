# PMOS Pipeline Board — Product Requirements Document

**Version:** 1.0  
**Date:** June 2026  
**Owner:** AB Investments  
**Status:** Draft

---

## 1. Overview

PMOS (Property Management Operations System) is an internal operations board for the AB Investments team. It replaces ad-hoc tracking (spreadsheets, WhatsApp, verbal handoffs) with a single structured tool for managing the full lifecycle of property operations — leasing, maintenance, unit turns, and tenant escalations.

The system is a multi-pipeline Kanban board with per-ticket checklists, comments, SLA tracking, role-based access, and a full audit history. It is used exclusively by the internal AB Investments team.

---

## 2. Goals

- Give every team member a single place to see what is open, who owns it, and whether it is overdue.
- Enforce per-pipeline workflows so nothing falls through the cracks between stages.
- Surface SLA breaches before they become problems, not after.
- Give the admin a complete audit trail for every ticket without requiring manual note-taking.

---

## 3. Non-goals

- No tenant-facing portal. This is internal only.
- No financial tracking, invoicing, or accounting integration in v1.
- No mobile-native app. Responsive web is sufficient for v1.
- No real-time push (WebSockets). Polling or manual refresh is acceptable for v1.

---

## 4. Users and roles

There are two roles.

**Admin** can do everything: create and delete users, create and delete pipelines, create and move tickets, and delete any note. There is always at least one admin account.

**Staff** can create tickets, move tickets they are assigned to, add notes to any ticket, and view all pipelines and tickets. Staff cannot manage users or pipelines.

---

## 5. Pipelines

A pipeline represents one operational workflow. Each pipeline has a name, a short alphabetic code shown on the tab, an ordered list of stages, a priority/tag field with per-option SLA days, a category field, and a default checklist that is copied onto every new ticket.

The system ships with four default pipelines. Admins can create additional pipelines and delete existing ones, provided at least one pipeline always remains.

### 5.1 Leasing & Placement (code: A)

Tracks prospective tenants from first contact through move-in.

Stages: New Lead → Contacted → Showing → Applied → Screening → Approved → Lease Sent → Signed & Paid → Moved In

Priority field label: **Lead Temp**

| Option | SLA |
|--------|-----|
| Hot    | 2 days |
| Warm   | 4 days |
| Cold   | 7 days |

Category field label: **Source** — options: Zillow, Apartments.com, MLS, Referral, Drive-by, Other

Default checklist: ID collected · Pay stubs / bank statements · Rental history checked · Background check run

### 5.2 Maintenance & Vendors (code: C)

Tracks repair and maintenance requests from report through invoice close.

Stages: Reported → Triaged → Vendor Assigned → Confirmed → Scheduled → In Progress → Invoice Pending → Closed

Priority field label: **Urgency**

| Option    | SLA |
|-----------|-----|
| Emergency | 1 day |
| Urgent    | 2 days |
| Routine   | 7 days |

Category field label: **Category** — options: HVAC, Plumbing, Electrical, General, Appliance

Default checklist: Photos before · Photos after · Invoice uploaded · Tenant notified

### 5.3 Unit Turns (code: D)

Tracks the process of preparing a vacated unit for re-leasing.

Stages: Notice Received → Walkthrough → Scope Defined → Vendor Work → Touch-ups → Turn Complete → Re-Leased

Priority field label: **Priority**

| Option   | SLA |
|----------|-----|
| Rush     | 3 days |
| Standard | 7 days |

Category field label: **Turn Size** — options: Light Turn, Standard Turn, Heavy Turn

Default checklist: Smoke detectors tested · All lights functioning · Plumbing leak-free · Doors/locks tested · Deep clean complete · Marketing photos taken

### 5.4 Escalation & Legal (code: E)

Tracks tenant violations and legal proceedings from logging through resolution.

Stages: Logged → Verifying → Verbal Warning → Written Notice → Cure or Quit → Eviction Filed → Resolved

Priority field label: **Severity**

| Option   | SLA |
|----------|-----|
| Severe   | 2 days |
| Moderate | 5 days |
| Minor    | 10 days |

Category field label: **Violation Type** — options: Non-payment, Noise, Damage, Lease Violation, Illegal Activity, Unauthorized Occupant, Habitability

Default checklist: Complaint documented · Facts verified (photos / witness / vendor report) · Notice delivered in writing

---

## 6. Tickets

A ticket represents one unit of work moving through a pipeline. Every ticket belongs to exactly one pipeline and occupies exactly one stage at a time.

### 6.1 Ticket fields

| Field        | Required | Notes |
|--------------|----------|-------|
| Title        | Yes      | Free text, e.g. "Maplewood #4B — Sarah Chen" |
| Pipeline     | Yes      | Set at creation, cannot be changed |
| Stage        | Yes      | Starts at stage 0, advanced manually |
| Property     | No       | Property name, e.g. "Maplewood Apartments" |
| Unit         | No       | Unit identifier, e.g. "4B" |
| Priority tag | No       | One of the pipeline's tag options |
| Category     | No       | One of the pipeline's category options |
| Assigned to  | No       | Display name of the assigned team member |
| Checklist    | Auto     | Copied from pipeline default on creation |
| Notes        | —        | Added post-creation |

### 6.2 Stage advancement

Moving a ticket to a new stage records a history entry with the stage name, entry timestamp, and the user who made the move. When a ticket reaches the final stage of its pipeline it is marked complete (`completed_at` is set). Moving it back out of the final stage clears `completed_at`.

### 6.3 Checklist

Each checklist item has a label and a boolean `done` state. Items can be checked or unchecked at any time by any authenticated user. The checklist is not a gate — tickets can advance to the next stage regardless of checklist completion in v1.

### 6.4 Notes / comments

Any authenticated user can add a plain-text note to any ticket. Notes are timestamped and attributed to the author by display name. Admins can delete any note. Staff can delete only their own notes.

### 6.5 Ticket history

Every stage transition is appended to the ticket's history log: stage index, stage name, entry time, and the user who made the move. This log is read-only and is displayed in the ticket drawer.

---

## 7. SLA and overdue logic

A ticket is **overdue** when all of the following are true:

- It is not in the final (terminal) stage of its pipeline.
- The number of calendar days since `stage_entered_at` is greater than or equal to the SLA days defined for its priority tag option.
- If the ticket has no tag set, it is never flagged as overdue.

The KPI bar above the board shows the count of open tickets, overdue tickets, and completed tickets for the active pipeline. The SLA note below the bar lists each tag option and its SLA threshold, e.g. "SLA — Hot 2d · Warm 4d · Cold 7d".

Overdue ticket counts are shown in red. Individual overdue cards show their age in red on the card footer.

---

## 8. Views

### 8.1 Board view

The default view. Displays one column per pipeline stage. Each column shows its stage name and ticket count. Tickets appear as cards inside the appropriate column.

Cards display: title, property/unit if set, priority tag badge, category badge, assignee avatar and name, age since last stage entry (red if overdue), and a "DONE" stamp on completed tickets.

Tickets can be dragged between columns. Dropping a card onto a column advances (or retreats) the ticket to that stage and appends a history entry.

### 8.2 History view

A flat table of all tickets in the active pipeline that have reached the terminal stage. Columns: ticket ID, title, property, assignee, completion date. Sorted by completion date descending.

### 8.3 Activity feed

A modal accessible from the top bar showing the 50 most recent notes across all tickets and all pipelines. Each entry shows the author avatar, author name, note text, ticket title, and timestamp.

---

## 9. Filtering

A dropdown in the subbar filters the active board to "All tickets" or "Assigned to me" (tickets where `assigned_to` matches the logged-in user's display name).

---

## 10. Authentication and session

Login requires a username and password. On success the server issues a JWT (24-hour TTL, HS256). The token is stored in the browser and sent as a `Bearer` header on all subsequent API requests. On expiry the user is returned to the login screen.

Password storage uses bcrypt. Passwords are never returned by any API endpoint.

---

## 11. Admin settings

Accessible to admin users only via the "Admin settings" button in the top bar. Contains two tabs.

**Team tab** — lists all users with their display name, username, and role. Admin can create new users (username, display name, password, role) and delete existing users. An admin cannot delete their own account.

**Services tab** — lists all pipelines with their code, label, stage count, and ticket count. Admin can delete a pipeline (which also deletes all tickets in it, with a confirmation prompt) and can create new pipelines by specifying a name, code, stages (minimum 2), priority tag options with SLA days, category options, and a default checklist. A "Restore default 4 services" button re-adds any of the four default pipelines that have been deleted.

---

## 12. API

The backend exposes a REST API at `/api`. All routes except `POST /api/auth/login` require a valid JWT.

### Auth
`POST /api/auth/login` — `{username, password}` → `{token, user}`

### Users (write = admin only)
`GET /api/users` — list all users (no password fields)  
`POST /api/users` — create user  
`PATCH /api/users/:id` — update display name, password, or role  
`DELETE /api/users/:id` — delete user (blocked for self)

### Pipelines (write = admin only)
`GET /api/pipelines` — list all  
`GET /api/pipelines/:id` — single pipeline  
`POST /api/pipelines` — create (min 2 stages)  
`PATCH /api/pipelines/:id` — partial update  
`DELETE /api/pipelines/:id` — blocked if last pipeline

### Tickets
`GET /api/pipelines/:pipelineId/tickets` — list; `?mine=true` filters to caller  
`GET /api/tickets/:id` — single ticket with notes and pipeline  
`POST /api/tickets` — create; copies default checklist from pipeline  
`PATCH /api/tickets/:id` — update fields and/or advance stage  
`PATCH /api/tickets/:id/checklist` — `[{index, done}]` patches  
`DELETE /api/tickets/:id`

### Notes
`GET /api/tickets/:ticketId/notes` — all notes for a ticket  
`POST /api/tickets/:ticketId/notes` — add note (author = JWT user)  
`DELETE /api/notes/:id` — admin or note author only  
`GET /api/activity` — 50 most recent notes across all tickets

---

## 13. Tech stack

| Layer      | Choice                  |
|------------|-------------------------|
| Language   | Go 1.22                 |
| Framework  | Fiber v2                |
| ORM        | Ent                     |
| Database   | PostgreSQL 16           |
| Auth       | JWT HS256, bcrypt       |
| Frontend   | Existing HTML/JS static |
| Deployment | Docker / docker-compose |

---

## 14. Data model

**User** — id, username (unique, lowercase), display_name, password_hash, role (admin | staff), created_at

**Pipeline** — id, label, code, stages (JSON array), tag_field (JSON), category_field (JSON), default_checklist (JSON array), created_by, created_at

**Ticket** — id, title, property, unit, tag, category, assigned_to, stage_index, checklist (JSON), history (JSON), created_at, stage_entered_at, completed_at (nullable); belongs to one Pipeline

**Note** — id, text, author, created_at; belongs to one Ticket

---

## 15. Constraints and business rules

- There must always be at least one pipeline. Deletion of the last pipeline is blocked.
- A pipeline must have at least two stages to be created.
- Username must be unique (case-insensitive).
- An admin cannot delete their own account.
- Ticket pipeline cannot be changed after creation.
- Stage history entries are append-only and cannot be edited or deleted.
- Notes can only be deleted by the note author or an admin.
- `completed_at` is set automatically when a ticket reaches the terminal stage and cleared automatically if it is moved back.

---

## 16. Out of scope for v1

- Email or push notifications for SLA breaches or assignments.
- File/photo attachments on tickets or notes.
- Bulk ticket actions.
- CSV/Excel export.
- Multi-tenancy (multiple organisations sharing one instance).
- Audit log for user and pipeline changes (only ticket stage history is tracked).
- Two-factor authentication.