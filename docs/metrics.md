# Metric definitions (PRD §24.5)

Every number on a CivicEye dashboard is defined here. The code that computes them is in
`src/modules/analytics/`; integration tests check each one against hand-counted data.

## Conventions

- **Time zone:** Bangladesh time (UTC+06:00, no daylight saving). A date range `from`–`to`
  covers `from` 00:00 to the end of `to`, Bangladesh time. Default: the last 30 days, today
  included. Longest range: 366 days.
- **Backlog (now)** counts what is open at the moment of the request, and ignores the date range.
- **Volume (in range)** counts events whose moment falls inside the date range.
- **Durations** are reported as **median**, **90th percentile** and **mean**, in hours, with the
  number of cases (`count`). Each duration belongs to the range in which it **ended** (for
  example, a resolution time counts in the range where the report was resolved).
- **Too few cases:** when `count` is under **5**, `enoughData` is `false` and the website shows
  "Too few cases to judge" instead of presenting the number as performance (PRD §24.5).
- **Weeks** start on Monday, Bangladesh time. Trends show the last 12 complete or current weeks.
- Only stored timestamps are used, never estimates; a case missing either end is left out.

## Durations

| Metric              | Starts                                           | Ends                                                                                                                              | Attributed to                                  |
| ------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Review time**     | Report submitted (`reports.submitted_at`)        | First review decision (accept or reject) on that report (`report_review_decisions.created_at`)                                    | The organization that made that first decision |
| **Resolution time** | Report submitted                                 | First time the report became `RESOLVED` (`report_status_history`); `RESOLVED` follows the organization's verification of the work | The organization handling the report now       |
| **Assignment time** | First time the report became `ACCEPTED`          | First assignment created after it (`report_assignments.assigned_at`)                                                              | The organization of that assignment            |
| **Completion time** | Worker started (`report_assignments.started_at`) | Worker submitted completion (`report_assignments.completed_at`)                                                                   | The organization and worker of that assignment |

Transfers: review and resolution times start at submission, so a report transferred between
organizations includes the time spent at the first one. This is what the citizen experiences;
it can make the receiving organization look slower.

## Organization dashboard

Visible to Org Admins and Reviewers of that organization only.

**Backlog (now)**, reports the organization handles, by status:

| Group                      | Statuses                                 |
| -------------------------- | ---------------------------------------- |
| Awaiting review            | `SUBMITTED`, `UNDER_REVIEW`, `REOPENED`  |
| Waiting for the citizen    | `NEEDS_INFORMATION`                      |
| Accepted, not yet assigned | `ACCEPTED`                               |
| In progress                | `ASSIGNED`, `IN_PROGRESS`                |
| Awaiting verification      | `WORK_COMPLETED`, `PENDING_VERIFICATION` |

**Volume (in range):**

- **Received:** distinct reports routed to the organization (automatically or by a Super Admin)
  or transferred to it, in range.
- **Accepted / Rejected:** the organization's review decisions in range.
- **Resolved:** reports the organization handles that first became `RESOLVED` in range.
- **By category:** received reports by their current category.
- **By service area:** received reports by the organization's service area that contains them;
  a report inside two overlapping areas counts in both; "Outside your areas" counts the rest.
- **Worker workload:** per worker, open assignments now by state (`PENDING`, `ACCEPTED`,
  `IN_PROGRESS`, `COMPLETED` = awaiting verification) and assignments `VERIFIED` in range.
- **Trend:** received and resolved per week, last 12 weeks.

## Worker dashboard

Each worker's own tasks, across all their organizations.

- **Pending:** assigned, not yet accepted (`PENDING`).
- **Active:** `ACCEPTED` or `IN_PROGRESS`.
- **Awaiting verification:** `COMPLETED`.
- **Completed:** `VERIFIED`, all time and in the last 30 days.
- **Overdue:** `PENDING` for more than 48 hours (the approved acceptance reminder policy;
  CivicEye has no other task deadlines).
- **Recent history:** the 10 most recently assigned tasks and their state.

## Citizen dashboard

Each citizen's own reports only.

- **Total:** all reports the citizen submitted.
- **Open:** not in a final state (`RESOLVED`, `CLOSED`, `REJECTED`, `WITHDRAWN`, `DUPLICATE`).
- **Resolved:** `RESOLVED` or `CLOSED` after resolution.
- **By status** and **recent activity:** the 10 latest status changes on the citizen's reports.
- **Unread notifications.**

## Super Admin dashboard

- **Users:** by account status; new registrations in range.
- **Organizations:** total, active, verified.
- **Reports:** total; submitted in range; by status now; by category in range; waiting in triage now.
- **Organization performance:** per organization, received and resolved in range, backlog now,
  and median resolution time (with `count`).
- **Geographic distribution:** reports submitted in range by handling organization, and those
  no organization covers.
- **Platform activity:** per week, last 12 weeks: reports submitted, reports resolved, new users.
- **Moderation workload:** open moderation cases by state; flags received in range.
- **AI processing health:** the AI switch, the service's model version, and the last 7 days of
  analyses (see `GET /admin/ai/status`).
