# Database Reference

Every table in the database, what it stores, and what relates to what.

All tables live in the `public` schema in your Supabase PostgreSQL database. The complete creation script is `database/00_baseline.sql`.

---

## Table-by-table reference

### 1. Q&A core

#### `questions`
The heart of the app — one row per question submitted by staff.

| Column            | Type                | Notes                                                   |
|-------------------|---------------------|---------------------------------------------------------|
| `id`              | uuid (PK)           | Internal identifier.                                    |
| `question_id`     | text                | Human-readable ID (Q-001, Q-002…). Auto-generated.      |
| `submitted_at`    | timestamptz         | When the question was created.                          |
| `submitter_name`  | text                | Display name of the submitter.                          |
| `submitter_email` | text                | Email of the submitter (used for permissions).          |
| `task_id`         | text                | "Bill ID" in the UI. The task the question is about.    |
| `question`        | text                | The actual question text.                               |
| `issue_field`     | text                | Category: Vendor, Expense, Payment, etc.                |
| `priority`        | text                | Legacy mirror of `issue_field`. Kept in sync by trigger.|
| `links`           | text                | Optional URLs or references.                            |
| `status`          | text                | Open / In Review / Answered / Closed.                   |
| `answer`          | text                | The reviewer's answer.                                  |
| `remarks`         | text                | Internal remarks.                                       |
| `answered_by`     | text                | Reviewer who answered.                                  |
| `answered_date`   | timestamptz         | When the answer was given.                              |
| `due_at`          | timestamptz         | SLA deadline. Auto-computed from `submitted_at`.        |
| `is_archived`     | boolean             | True if archived (still in DB but hidden from staff).   |
| `archived_at`     | timestamptz         | When archived.                                          |
| `archived_by`     | text                | Who archived it.                                        |
| `archive_reason`  | text                | Why.                                                    |
| `custom_fields`   | jsonb               | Open-ended fields for admin-defined customization.      |

#### `question_comments`
Threaded follow-up comments on questions.

| Column              | Type        | Notes                                            |
|---------------------|-------------|--------------------------------------------------|
| `id`                | uuid (PK)   |                                                  |
| `question_id`       | uuid (FK)   | → `questions.id`. Deletes cascade.               |
| `user_email`        | text        |                                                  |
| `user_name`         | text        |                                                  |
| `text`              | text        | The comment body.                                |
| `is_reviewer_reply` | boolean     | True if author is a reviewer.                    |
| `is_resolved`       | boolean     | Can be marked resolved.                          |
| `parent_comment_id` | uuid (FK)   | → self. For threading replies.                   |
| `created_at`        | timestamptz |                                                  |
| `updated_at`        | timestamptz |                                                  |

#### `question_views`
Tracks who has read which answers, deduplicated per session.

| Column         | Type        | Notes                                                  |
|----------------|-------------|--------------------------------------------------------|
| `id`           | uuid (PK)   |                                                        |
| `question_id`  | uuid (FK)   | → `questions.id`. Deletes cascade.                     |
| `viewer_email` | text        | The user who viewed.                                   |
| `viewer_name`  | text        |                                                        |
| `session_key`  | text        | Unique per (question, viewer, session). No duplicates. |
| `viewed_at`    | timestamptz |                                                        |

---

### 2. Roles & permissions

#### `app_user_roles`
**The canonical source of who has what role.** Replaces the older `reviewers` table.

| Column        | Type        | Notes                                                                   |
|---------------|-------------|-------------------------------------------------------------------------|
| `email`       | text (PK)   | The user's email (matches their Google account).                        |
| `role`        | text        | One of: `staff`, `reviewer`, `admin`, `primary_admin`.                  |
| `assigned_by` | text        | Email of admin who assigned this role.                                  |
| `created_at`  | timestamptz |                                                                         |
| `updated_at`  | timestamptz |                                                                         |

#### `reviewers` *(legacy — kept for compatibility)*
Older email-only reviewer table. The frontend still queries it, so it stays. The baseline keeps it auto-seeded with the primary admin.

| Column       | Type        | Notes |
|--------------|-------------|-------|
| `email`      | text (PK)   |       |
| `created_at` | timestamptz |       |
| `created_by` | text        |       |

> **Future cleanup:** Once frontend code is updated to read role exclusively from `app_user_roles`, the `reviewers` table can be removed in a future migration.

---

### 3. Admin configuration

#### `issue_fields`
Category tags admins can manage (Vendor, Expense, etc.).

| Column        | Type        | Notes                                                                                                 |
|---------------|-------------|-------------------------------------------------------------------------------------------------------|
| `id`          | uuid (PK)   |                                                                                                       |
| `name`        | text        | Unique, displayed in UI.                                                                              |
| `description` | text        |                                                                                                       |
| `color_class` | text        | One of: info, purple, pink, green, amber, red, muted.                                                 |
| `sort_order`  | integer     | Lower = appears first.                                                                                |
| `is_active`   | boolean     | Soft-disable without deleting.                                                                        |

#### `sla_settings`
Single-row configuration (id is always 1).

| Column            | Type        | Notes                                  |
|-------------------|-------------|----------------------------------------|
| `id`              | int (PK)    | Always = 1.                            |
| `response_days`   | integer     | SLA deadline in working days.          |
| `exclude_weekends`| boolean     | Skip Sat/Sun when calculating due_at.  |
| `timezone`        | text        | e.g. `Asia/Kathmandu`.                 |

#### `app_settings`
Flexible JSON key-value store for admin customization.

| Column       | Type        | Notes                                              |
|--------------|-------------|----------------------------------------------------|
| `key`        | text (PK)   |                                                    |
| `value`      | jsonb       | Anything: object, array, scalar.                   |
| `updated_by` | text        |                                                    |
| `updated_at` | timestamptz |                                                    |

---

### 4. Activity logging

#### `activity_log`
General audit trail.

| Column         | Type        | Notes                                       |
|----------------|-------------|---------------------------------------------|
| `id`           | uuid (PK)   |                                             |
| `actor_email`  | text        | Who did it.                                 |
| `actor_name`   | text        |                                             |
| `action`       | text        | e.g. "question.answered".                   |
| `target_table` | text        | Which table was affected.                   |
| `target_id`    | uuid        | Which row.                                  |
| `target_label` | text        | Human-friendly label.                       |
| `details`      | jsonb       | Anything extra.                             |
| `created_at`   | timestamptz |                                             |

#### `admin_customization_activity`
Audit trail specifically for admin customization changes.

---

### 5. Team chat (Slack-style)

All chat tables are prefixed `collab_`.

| Table                     | Purpose                                                                  |
|---------------------------|--------------------------------------------------------------------------|
| `collab_profiles`         | One row per user with display name, avatar, department, bio, etc.        |
| `collab_channels`         | Chat rooms (channels). Public or private.                                |
| `collab_channel_members`  | Who's in which channel.                                                  |
| `collab_messages`         | The actual messages. Soft-delete via `deleted_at`.                       |
| `collab_message_reactions`| Emoji reactions on messages.                                             |
| `collab_message_reads`    | Read receipts (per user per message).                                    |
| `collab_typing`           | "User is typing…" indicators. Auto-expire.                               |
| `collab_notifications`    | In-app notifications (mentions, answers, etc.).                          |

These tables are added to the `supabase_realtime` publication, so the JS client can subscribe to them and receive live updates over WebSocket.

---

### 6. Cross-cutting

#### `app_reactions`
Generic emoji-reaction storage for questions/comments (not chat messages — those use `collab_message_reactions`).

| Column        | Type        | Notes                                                       |
|---------------|-------------|-------------------------------------------------------------|
| `id`          | uuid (PK)   |                                                             |
| `target_type` | text        | e.g. `question`, `comment`.                                 |
| `target_id`   | text        | The target's ID as text.                                    |
| `emoji`       | text        |                                                             |
| `user_email`  | text        |                                                             |
| `user_name`   | text        |                                                             |
| `created_at`  | timestamptz |                                                             |

> **Note:** This table was referenced by the frontend but missing from the older SQL files. The new baseline adds it.

---

## Views (read-only)

These are saved queries that the admin dashboard reads.

### `v_dashboard_health`
One row with counts: active, archived, open, answered on time, due today, overdue.

### `v_question_analytics`
One row per question with computed columns: response time in hours, SLA status label, etc.

### `v_submitter_rollup`
Per-submitter aggregates: how many questions asked, how many answered, avg response time, last activity.

---

## Relationships at a glance

```
                    app_user_roles ◄── (current role source of truth)
                          │
                          │ (synced loosely)
                          ▼
                      reviewers ◄── (legacy, still read by frontend)


questions ──┐
            ├─► question_comments (1 question → many comments, threaded)
            ├─► question_views    (1 question → many view records)
            └─► (referenced by app_reactions via target_id)

collab_channels ──┐
                  ├─► collab_channel_members  (membership)
                  ├─► collab_messages         ┐
                  │                           ├─► collab_message_reactions
                  │                           ├─► collab_message_reads
                  │                           └─► (mentions array)
                  └─► collab_typing

collab_profiles  ←─ referenced by name throughout chat tables
collab_notifications  (recipient_email links by string, not FK — intentional for flexibility)
```

---

## Normalization notes

The schema is in **3rd Normal Form** for the parts that matter (`questions`, `question_comments`, `app_user_roles`, chat tables). Two intentional violations:

1. **`questions.priority` mirrors `questions.issue_field`.** This is to keep the older frontend code working without breaking changes. A trigger keeps them in sync. Future migration: drop `priority` after frontend is updated.

2. **`questions.submitter_name`, `submitter_email`, `answered_by`** are denormalized text fields rather than foreign keys to `collab_profiles`. This is intentional: if a user is removed or their email changes, historical questions still show the original info. Trade-off: a name change in profile doesn't propagate to old records.

For an internal tool of this size, both trade-offs are correct choices.
