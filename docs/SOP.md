# Standard Operating Procedures

These procedures use the page names, links, and buttons in the ATM Cash Operations screens. Each person signs in with their own account. Lists, forecasts, and saves are limited to that account's region, branch, custodian, or engineer. A record outside that area opens **Access Denied** and is not changed.

The sample sign-in names are created for the demonstration fleet. Passwords are not written in this document. A Super Admin sets them on **User Accounts**, or the first Super Admin password is saved on the setup page when that page is open.

## Contents

1. [Signing in and account security](#1-signing-in-and-account-security)
2. [Daily cash position](#2-daily-cash-position)
3. [Raising and approving a replenishment run](#3-raising-and-approving-a-replenishment-run)
4. [Loading cassettes](#4-loading-cassettes)
5. [Reconciliation and variance cases](#5-reconciliation-and-variance-cases)
6. [Fault tickets, downtime, and SLA](#6-fault-tickets-downtime-and-sla)
7. [Bank files, alerts, and the live feed](#7-bank-files-alerts-and-the-live-feed)
8. [User administration](#8-user-administration)
9. [Activity log](#9-activity-log)
10. [End-of-day checks](#10-end-of-day-checks)
11. [Escalation matrix](#11-escalation-matrix)

## 1. Signing in and account security

### Sign in

1. Open the sign-in page.
2. Enter the username and password. **Show** reveals the password. **Hide** masks it again. The form still submits if that control is not used.
3. Choose **Sign In**.
4. A wrong password, an unknown username, and a locked account all show **Invalid username or password.** The screen does not say which of those it was.
5. After five wrong passwords for an existing active account, the account locks for 15 minutes. Further attempts during the lock still show the same message and do not add to the count.
6. More than 30 sign-in attempts from the same network address in 15 minutes show a message to try again later.
7. A session that has been idle too long, or that has passed its absolute limit, returns to the sign-in page with **Your session expired. Sign in again.** The idle limit and the absolute limit come from the server configuration. When they are not set, idle is 30 minutes and the absolute limit is 8 hours. Activity during the session extends the idle timer.
8. Choose **Log Out** at the bottom of the navigation. That ends the session.

### First Super Admin password

The setup page is available only when a setup token is configured and the Super Admin does not yet have a password. It is also available when recovery is turned on with the exact value required by the server, and it is hidden again when that switch is removed.

1. Open the setup page.
2. Enter the setup token, the new password, and the same password again.
3. The password must be at least 12 characters. The two entries must match.
4. Choose **Save Password**.
5. Sign in on the sign-in page. The setup page then answers **Page Not Found** until recovery is turned on again.

A wrong token shows **The setup token does not match.** The attempt is written to the activity log as a rejected first-run setup.

### Passwords set by a Super Admin

On **User Accounts**, **Set Password** requires at least 8 characters and a matching confirmation. Saving a password, changing a role, or disabling an account ends that user's existing sessions. **Unlock** clears the failure count and the lock. It does not set a new password.

## 2. Daily cash position

Do this at the start of the day. The figures include only your area.

1. Open **Uptime Dashboard**. The page title is **Fleet Uptime**.
2. Read the six indicators: **Fleet Uptime**, **Above 5% Downtime**, **Open Fault Tickets**, **Cash-Out or Down**, **Dispensed Yesterday**, and **Runs Today**.
3. If **Likely Cash-Out Within 24 Hours** is present, note the ATM, the cash still in the machine, tomorrow's forecast, and **Hours Left**. Hours left are current cash divided by tomorrow's forecast, times 24. The list keeps machines at 24 hours or under.
4. Read **Cash Alerts**. Follow **+N more** to **Cash Alerts** when the dashboard does not show every open alert.
5. Read the open-downtime line. Follow it to **Open Downtime** when there are more windows than the line shows.
6. If you can open reports, follow the link that says how many open tickets are past an SLA target. That link is **SLA Report**.
7. Open **ATMs** and use **Filter** for a location, a status, or a search. Statuses are active, cash out, out of service, and decommissioned.
8. Open one ATM. The detail shows the machine, recent withdrawals, the next days of forecast, recent tickets, downtime, and cassette loads.

Cash Officers, Branch Managers, and Regional Managers can also open **Cash Forecast**, choose an ATM and a date, and choose **Forecast**. The result is the same-weekday average over the previous 28 days, times the salary-day, month-end, and holiday factor. An ATM outside your area is **Access Denied**.

## 3. Raising and approving a replenishment run

### Plan routes

Branch Managers, Regional Managers, and the Super Admin see the planner on **Replenishment Runs**.

1. Open **Replenishment Runs**.
2. Set **Plan date**. Leave **Location** as **All locations** to plan every location you are allowed to see, or choose one location in your area.
3. Choose **Plan Routes**.
4. The notice reports how many runs and ATMs were planned. Planning the same date again does not add an ATM that is already on a non-cancelled run. A location outside your area is **Access Denied** and nothing is planned.
5. The line **Latest planner results** shows the date, the run count, and the ATM count for recent plans.

The planner selects ATMs whose forecast is above the cash still in the machine, skips a shortfall under 100, and does not use a van that is in maintenance. Each run stays under 15 ATMs.

### Record a run by hand

Cash Officers, Branch Managers, Regional Managers, and the Super Admin can do this.

1. On **Replenishment Runs**, choose **New Run**. The page title is **New Replenishment Run**. The location, van, custodian, and ATM lists contain only your area.
2. Set the run date, location, cash van, and custodian. The van must belong to that location and must not be in maintenance. The custodian must be active and assigned to that van.
3. Enter one row per cassette: ATM code, cassette 1 to 4, denomination 100, 200, 500, or 2000, and a note count from 1 to 10,000. **Add Cassette Row** adds a row. **Remove** drops one.
4. Check **Total loaded**. It is the sum of denomination times note count and updates as you type.
5. Choose a status of planned, in progress, completed, or cancelled.
6. Choose **Save Run**. A Cash Officer's saved run is marked waiting for approval. The run page says it is waiting for approval before it can be dispatched or completed.

Choosing in progress or completed before the run is approved does not save that change. The page returns **This run has to be approved before it can be dispatched or completed.** Save as planned first. Saving an ATM or a location outside your area is **Access Denied** and does not create the run.

Opening **New Run** with an ATM from **Cash Forecast** fills the suggested ₹500, ₹200, and ₹100 counts when the suggestion is above zero. Change any count before saving.

### Approve

1. Open the run.
2. If it is waiting for approval and you are a Regional Manager or the Super Admin, choose **Approve Run**.
3. After **Approve Run**, the Cash Officer or Branch Manager can save the run as in progress or completed. A Branch Manager can plan, edit, and delete runs in the branch, and cannot approve a run.

### Custodian

A Custodian opens **Replenishment Runs** and sees their own trips. They can edit a run assigned to them. They cannot plan, approve, or delete, and they cannot open another custodian's run.

## 4. Loading cassettes

Cassette loads are the rows on the run, not a separate screen.

1. Open the run from **Replenishment Runs**. The page title is **Edit Replenishment Run**.
2. Confirm the ATM codes are machines on that trip. An ATM must belong to the selected location. The same ATM and cassette cannot appear twice. The same ATM cannot be on two non-cancelled runs on the same date.
3. The load for an ATM cannot exceed the room left in that ATM: capacity minus cash still in the machine. The error names the ATM and the amount still available.
4. Choose **Save Run**.
5. To remove the whole trip, a Branch Manager, Regional Manager, or Super Admin chooses **Delete Run** and confirms **Delete this run and its cassette loads?** Deleting a run outside your area is refused, and the run remains.

Created-by on the page reads **Route Planner** when the planning procedure created the run, and **Operator** when a person saved it.

## 5. Reconciliation and variance cases

### Record the count

Cash Officers, Branch Managers, Regional Managers, and the Super Admin can do this.

1. Open **Reconciliation**, then the new-reconciliation form. The page title is **New Reconciliation**. ATM and run lists are limited to your area.
2. Choose the ATM, optionally the replenishment run, the reconciliation date, the expected amount, and the counted amount. The date cannot be in the future. Amounts must be within the ledger limit.
3. Choose **Save Reconciliation**.
4. If the counted amount equals the expected amount, the notice says the count matched and no fault ticket was raised.
5. If they differ, the notice names the ticket and the difference, and the browser goes to **Fault Tickets**. The case status is Raised. The absolute difference sets the ticket priority: critical from 100,000, high from 10,000, otherwise medium.

### Work the case

1. Open the case from **Reconciliations**. The heading is the ATM code and the status. The difference and the reconciliation date are under the heading.
2. Read **Notes**. To add one, type in **Add a note** and choose **Add Note**. Notes are limited to 2,000 characters.
3. While the case is Raised, **Next status** offers **Investigating**. Choose **Update Case**. A Cash Officer can do this.
4. While the case is Investigating, a Branch Manager, Regional Manager, or Super Admin can set **Next status** to **Resolved** or **Written Off**.
5. Choose a **Reason**: counting error, dispense fault, fraud suspected, cassette mismatch, or other. **Assignee** can stay **Unchanged** or name a person.
6. Choose **Update Case**. The page then shows when it was closed and the reason.

A Cash Officer who tries to resolve or write off sees **A branch or regional manager has to approve the resolution.** Any other jump, such as Raised straight to Resolved, shows **That status change is not allowed.** A case outside your area is **Access Denied**, including notes and status changes.

**Open Case Ageing** lists cases that are not closed and the number of days since they were created.

## 6. Fault tickets, downtime, and SLA

### Tickets

1. Open **Fault Tickets**.
2. Use **Filter** on status (open, assigned, closed) and category (cash variance, cash out, hardware, communication, cassette error).
3. To assign, choose an engineer and **Assign**. The ticket becomes assigned, and the response time is set if it was empty. A Cash Officer does not see **Assign**. An Engineer does not assign tickets.
4. To close, type a resolution and choose **Close**. The ticket records the closed time and, if it was empty, the resolved time. An Engineer can close a ticket assigned to them. Closing someone else's ticket is **Access Denied**. A closed ticket cannot be assigned or closed again.

There is no separate screen for typing a new fault by hand. Tickets are raised by a reconciliation difference or by a fault code on a bank file or the live feed.

### Downtime

1. Open **Open Downtime** to see windows that have not ended. The reason is cash out, hardware, communication, power, cassette error, or vandalism.
2. This page does not have a close button. An offline row on a bank file or the live feed starts a window after the machine has been offline for the configured threshold. A later online row closes it. Stopping the live feed closes downtime that the feed itself opened.
3. Open **Downtime by Location** for average month-to-date downtime and the minutes this month by reason.
4. Open **Downtime Above 5%** for machines whose merged month-to-date outage is strictly above 5% of the minutes elapsed this month.

### SLA

1. Open **SLA Report**.
2. Read response hours and resolution hours against the target for each category. Communication uses the network target. Anything else that is not cash-out, hardware, or power uses the other target.
3. A breach is a response, or a resolution, that took longer than the target. Open tickets are measured up to the current time when they have not yet been answered or closed.
4. A Super Admin can change the hours for a category and choose **Save**. Hours must be greater than zero. The change is written to the activity log.

The targets stored with the schema are: cash-out 2 hours to respond and 4 to resolve, hardware 4 and 8, network 4 and 8, power 4 and 12, and other 8 and 24.

## 7. Bank files, alerts, and the live feed

### Import a file

Regional Managers and the Super Admin can do this. Rows for ATMs outside the Regional Manager's region are rejected with **That ATM is outside your area.**

1. Open **Bank Data Import**.
2. Choose a file, or paste rows. Each row needs the ATM code, the date, the amount, and the transaction count. Dates are calendar days. Amounts cannot be negative. A future date is rejected. A second row for the same ATM and date in one batch is rejected. An unknown ATM code is rejected.
3. Tick **Replace an existing total for the same ATM and date** only when that day's total should be overwritten. Otherwise an existing total is rejected.
4. Choose **Validate and Load**.
5. Open the batch from **Recent Batches** or from **Import History**. Accepted rows are the day's withdrawal totals. Rejected rows stay on the batch with the reason.

Optional columns, after the four required ones, are a cash level, a fault code, and online or offline. A cash level replaces the cash still in the machine when that row is the newest observation for the ATM. A level at or below the alert percentage of capacity opens one cash alert. A fault code opens one open ticket for that ATM and code. Offline starts downtime only after the offline threshold. Online closes it.

The server also watches an inbound folder. A file is loaded once, identified by its SHA-256. Accepted files are moved to the processed folder. A file with nothing accepted is moved to the rejected folder. On a free host the disk does not keep those folders across a restart.

### Cash alerts

Open **Cash Alerts** to see every open alert in your area: the ATM, the cash, the capacity, and the threshold. The dashboard shows the latest ones and a link when there are more. There is no button on that page to close an alert.

### Live feed

The live feed is a demonstration on Fleet Uptime. Only a Super Admin sees it.

1. Choose **Live Feed** to start. The notice says it stops itself after 15 minutes.
2. The dashboard reloads when the feed's tick changes, so the new alerts, tickets, and downtime appear.
3. Choose **Stop Live Feed** to stop early. Downtime and tickets that the feed opened are closed with the note that the feed stopped. Other downtime is left open.
4. The feed never starts by itself.

## 8. User administration

Only a Super Admin sees **User Accounts**.

1. Choose **New User** to create an account. Choose **Create User**. The account cannot sign in until **Set Password** has been used, unless a demonstration password was supplied in the server configuration when the account was first created.
2. Choose **Edit account** to change a person, then **Save User**. Changing the role or disabling the account ends their sessions.
3. **Set Password** stores a new password of at least 8 characters, clears a lock, and ends their sessions. The password is not shown again.
4. If the status line says **Locked**, choose **Unlock**. The person can sign in with the existing password.
5. If the status line says **No password**, use **Set Password** before expecting a sign-in to work.
6. **Disabled** accounts cannot sign in.

Do not put passwords in notes, tickets, or the activity export. The activity log records that a password was set. It does not record the password.

## 9. Activity log

Super Admins see every region. Regional Managers see only their own region. Other roles do not see **Activity**.

1. Open **Activity**.
2. Filter by user, role, type, outcome, and dates. Types are **Sign-in History**, **Pages Opened**, and **Changes**. Outcomes are **Allowed**, **Denied**, and **Failed**.
3. Choose **Filter**.
4. Read **What Happened**. A change lists the field, the previous value, and the new value. A page opened shows the path.
5. Choose **Export** for a CSV of up to 5,000 rows. Times are India Standard Time to the second. A cell that starts with `=`, `+`, `-`, or `@` is stored with a leading apostrophe so a spreadsheet does not treat it as a formula.

The log cannot be edited or deleted in the application. A denied page is still listed, with outcome Denied, so a refused attempt is visible.

## 10. End-of-day checks

There is no separate end-of-day posting screen. Use the pages below.

| Check | Page | What to look for |
| --- | --- | --- |
| Tomorrow's trips | Replenishment Runs, filtered to tomorrow | Runs are planned, or a reason was given for not planning. Runs that need approval are not left in progress |
| Uncounted trips | Reconciliation | A completed trip that should have a count has one. Differences are Raised or already Investigating |
| Open cases | Open Case Ageing | Raised and Investigating cases have a note and, where needed, an assignee |
| Open tickets | Fault Tickets, status open or assigned | Each ticket has an engineer, or it is escalated using the matrix below |
| SLA | SLA Report | Breaches are visible. The dashboard count of open tickets past a target matches the report |
| Cash and downtime | Fleet Uptime, Cash Alerts, Open Downtime | Machines likely to cash out within 24 hours are on a run or an alert. Open downtime still has a reason |
| Access | Activity, for a Regional Manager or Super Admin | Denied and Failed rows for the day are expected, or they are escalated |
| Live feed | Fleet Uptime | If the feed was started, it has been stopped or it has stopped itself. It should not be left running overnight |

## 11. Escalation matrix

| Situation | Who acts | What they do |
| --- | --- | --- |
| Wrong password five times | Super Admin | **Unlock** on User Accounts after confirming the person. The lock also ends after 15 minutes |
| Super Admin cannot sign in and setup is hidden | Operator with the recovery switch | Turn recovery on, open the setup page with the setup token, save a new password of at least 12 characters, then turn recovery off |
| Run must go in progress or completed | Regional Manager or Super Admin | **Approve Run**. A Branch Manager cannot approve |
| Case must be resolved or written off | Branch Manager, Regional Manager, or Super Admin | **Update Case** with a reason. A Cash Officer cannot close it |
| Case or run is in another branch | The Branch Manager or Cash Officer of that branch | The other branch receives **Access Denied** and must not be given the record |
| Ticket needs an engineer | Branch Manager, Regional Manager, or Super Admin | **Assign** on Fault Tickets |
| Ticket is assigned and the site is back | The assigned Engineer, or a manager in the area | **Close** with a resolution |
| Ticket is past an SLA target | Branch Manager or Regional Manager | Read **SLA Report**, then assign or close. A Super Admin can change the hours with **Save** |
| Bank file has rows for another region | Regional Manager of that region, or Super Admin | Those rows are rejected for the first manager. Import them from an account that covers the ATMs |
| Cash alert or 24-hour cash-out | Branch Manager or Cash Officer | **Plan Routes** or **New Run** for that ATM. A Cash Officer's run waits for approval before it can be dispatched |
| Suspected fraud on a variance | Branch Manager | Set the reason to fraud suspected only when closing, and add a note while the case is Investigating. The application does not send an alert outside the ledger |
| Denied or failed activity that is not explained | Regional Manager for their region, Super Admin for any region | Filter Activity by outcome Denied or Failed and follow the user and the path |
