# Professional Workflow V1

## Objective
Add professional users (lawyers, valuers, inspectors, trustees, servicers) as first-class actors in application operations, while keeping final platform decisions with operator/admin.

## Scope
- Professional sign-up and onboarding approval.
- Operator assignment of professional work from application tasks.
- Professional execution lifecycle with structured outcomes.
- Issuer back-and-forth for additional information.
- Operator review and completion control.
- Full audit trail and SLA tracking.

## Non-goals (V1)
- Automated billing and payouts to professionals.
- Professional marketplace ranking algorithm.
- Multi-step external credential verification integrations.
- White-label multi-tenant organizations.

## Role Model (V1)
Add role: `professional`.

Decision boundaries:
- `admin`: approves professional onboarding and manages account lifecycle.
- `operator`: assigns work, reviews deliverables, accepts/rejects outcomes, closes tasks.
- `professional`: executes assigned work, requests more info, submits recommendation.
- `issuer`: responds to information requests and uploads supporting evidence.

## Data Model (V1)

### 1) Extend existing `users`
Add fields:
- `professionalId?: ObjectId` (ref `Professional`)
- `professionalMembershipRole?: "owner" | "member"`

Add role enum value:
- `professional`

Indexes:
- `professionalId`
- unique partial index on `{ email: 1 }` unchanged

### 2) Extend existing `professionals`
Keep existing model as the professional organization profile. Add:
- `onboardingStatus: "draft" | "submitted" | "in_review" | "approved" | "rejected"`
- `organizationType: "individual" | "firm"`
- `contactEmail: string`
- `contactPhone?: string`
- `website?: string`
- `jurisdictions?: string[]`
- `serviceCategories?: Array<"legal" | "valuation" | "inspection" | "trustee" | "servicing">`
- `licenseMeta?: { licenseNumber?: string; issuer?: string; expiresAt?: Date }`
- `complianceNotes?: string`
- `reviewedBy?: ObjectId`
- `reviewedAt?: Date`

Indexes:
- `onboardingStatus`
- `status`
- `serviceCategories`
- `jurisdictions`

### 3) New `professionalWorkOrders`
Purpose: track assignment and execution lifecycle independent of coarse task status.

Fields:
- `_id`
- `applicationId: ObjectId` (ref `Application`, indexed)
- `taskId: ObjectId` (ref `Task`, indexed)
- `businessId: ObjectId` (ref `Business`, indexed)
- `professionalId: ObjectId` (ref `Professional`, indexed)
- `assigneeUserId: ObjectId` (ref `User`, indexed)
- `category: "legal" | "valuation" | "inspection" | "trustee" | "servicing"`
- `status: "assigned" | "accepted" | "declined" | "in_progress" | "needs_info" | "submitted" | "under_review" | "completed" | "cancelled"`
- `priority: "low" | "normal" | "high"`
- `instructions: string`
- `dueAt?: Date`
- `acceptedAt?: Date`
- `startedAt?: Date`
- `submittedAt?: Date`
- `completedAt?: Date`
- `slaBreachedAt?: Date`
- `declineReason?: string`
- `operatorDecision?: "accepted" | "rejected" | "needs_changes"`
- `operatorNotes?: string`
- `outcome?: {
    recommendation: "approved" | "declined" | "needs_info";
    summary: string;
    riskFlags?: string[];
  }`
- `linkedReviewRoundId?: ObjectId` (when needs issuer input)
- `linkedReviewItemIds?: ObjectId[]`
- `createdBy: ObjectId`

Indexes:
- `{ applicationId: 1, status: 1 }`
- `{ assigneeUserId: 1, status: 1, dueAt: 1 }`
- `{ taskId: 1 }`
- `{ professionalId: 1, status: 1 }`

### 4) New `professionalWorkOrderEvents`
Purpose: immutable timeline for every transition/comment.

Fields:
- `_id`
- `workOrderId: ObjectId` (indexed)
- `actorUserId: ObjectId` (indexed)
- `actorRole: "admin" | "operator" | "issuer" | "professional"`
- `eventType: string` (examples: `Assigned`, `Accepted`, `RequestedInfo`, `SubmittedOutcome`, `OperatorApproved`)
- `payload: Mixed`
- `createdAt: Date`

Indexes:
- `{ workOrderId: 1, createdAt: -1 }`

### 5) Reuse existing `applicationReviewRounds` + `applicationReviewItems`
When a professional requests more info:
- create/update `applicationReviewRound`
- create `applicationReviewItem` with:
  - `itemType = "task"`
  - `itemKey = <taskId>`
  - `requestMessage` containing professional request
- issuer responds through existing review item flow
- operator/professional validates response and continues work order

## State Machines (V1)

### A) Professional onboarding
`draft -> submitted -> in_review -> approved | rejected`

Rules:
- only admin can move to `approved`/`rejected`
- rejected can return to `draft` on profile update

### B) Work order
`assigned -> accepted | declined`
`accepted -> in_progress`
`in_progress -> needs_info | submitted | cancelled`
`needs_info -> in_progress` (after issuer response validated)
`submitted -> under_review`
`under_review -> completed | in_progress`
`completed` terminal
`declined` terminal
`cancelled` terminal

Rules:
- professional cannot set `completed` directly
- operator sets final `completed`
- all required linked review items must be resolved before `completed`

## API Contract (V1)

## Auth and onboarding
- `POST /v1/professionals/register`
  - auth: anonymous or authenticated user without professional profile
  - body: profile payload
  - returns: `{ token, professional, user }`
- `POST /v1/professionals/me/submit-onboarding`
  - auth: professional
  - returns: updated professional
- `PATCH /v1/professionals/:id/onboarding-status`
  - auth: admin
  - body: `{ status: "in_review" | "approved" | "rejected", notes?: string }`

## Work order assignment and queue
- `POST /v1/tasks/:id/assign`
  - auth: operator/admin
  - body: `{ professionalId, assigneeUserId, instructions, dueAt?, priority? }`
  - returns: `professionalWorkOrder`
- `GET /v1/work-orders`
  - auth: operator/admin/professional
  - query: `status?, applicationId?, assigneeUserId?, professionalId?, dueBefore?, limit?`
  - returns: `professionalWorkOrder[]`
- `GET /v1/work-orders/:id`
  - auth: scoped
  - returns: work order + events + linked review items summary

## Professional execution actions
- `POST /v1/work-orders/:id/accept`
  - auth: assigned professional
- `POST /v1/work-orders/:id/decline`
  - auth: assigned professional
  - body: `{ reason }`
- `POST /v1/work-orders/:id/start`
  - auth: assigned professional
- `POST /v1/work-orders/:id/request-info`
  - auth: assigned professional or operator
  - body: `{ title, message, required: boolean, stageTag?, dueAt? }`
  - side effect: creates `applicationReviewItem` linked to task/work order
- `POST /v1/work-orders/:id/submit-outcome`
  - auth: assigned professional
  - body: `{ recommendation, summary, riskFlags?, deliverables[] }`
  - side effect: status to `submitted`

## Operator review and closure
- `POST /v1/work-orders/:id/start-review`
  - auth: operator/admin
  - side effect: status to `under_review`
- `POST /v1/work-orders/:id/review`
  - auth: operator/admin
  - body: `{ decision: "accepted" | "rejected" | "needs_changes", notes }`
  - side effect:
    - `accepted` -> `completed` and updates parent task `completed`
    - `needs_changes` -> `in_progress`
    - `rejected` -> `in_progress` or `cancelled` based on policy

## Timeline
- `GET /v1/work-orders/:id/events`
  - auth: scoped
  - returns chronological immutable event list

## Response envelope standard
All mutation responses should return current authoritative row state, not just `{ ok: true }`.

## UI Map (V1)

## Admin
- `/admin/professionals`
  - filter by onboarding status, service category, status
  - approve/reject onboarding
- `/admin/professionals/:id`
  - profile, credentials, review notes, associated users

## Operator
- `/operator/review`
  - application queue with "assign professional" shortcut on tasks
- `/operator/work-orders`
  - work order queue by status and SLA
- `/operator/work-orders/:id`
  - details, deliverables, request-info trigger, review decision
- `/operator/applications/:id`
  - embedded panel of linked work orders + review items

## Professional
- `/professional/onboarding`
  - profile completion and submission
- `/professional/work-orders`
  - "My assignments" queue with SLA and status
- `/professional/work-orders/:id`
  - instructions, issuer responses, upload deliverables, submit outcome

## Issuer
- existing `/issuer/applications/:id`
  - show professional-originated requests clearly
  - respond with docs/comments per item
  - status visibility: which professional request is blocking approval

## Operational Controls (must-have)
- SLA timers and overdue jobs (`assigned`, `in_progress`, `under_review`).
- Conflict check before assignment (same professional cannot approve own issuer entity).
- Strict object-level access (professional only sees assigned work orders).
- Idempotency for assignment and state transitions.
- Immutable event logging for every action.
- File controls: type/size validation, malware scan hook, signed URL retrieval.

## Technical Notes for current codebase
1. Add `professional` to `roles` in `utils/constants.ts` and RBAC matrix in `utils/rbac.ts`.
2. Add new model files under `db/models/`:
   - `professional-work-order.model.ts`
   - `professional-work-order-event.model.ts`
3. Create new module `modules/work-orders` with full split layout.
4. Keep `TaskModel` as parent requirement; work order is execution layer.
5. Reuse existing `applicationReviewRound` and `applicationReviewItem` for issuer back-and-forth to avoid duplicate systems.

## Delivery Plan
1. Phase 1: data model + RBAC + work order APIs + operator/professional queues.
2. Phase 2: issuer integration with professional-request tagging and linked resolution status.
3. Phase 3: SLA escalations, audit dashboards, reporting exports.
