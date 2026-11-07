# Where the limitations are disclosed

The point of this file: none of these limits live only in documentation.

| Moment | Surface | Enforced by |
|---|---|---|
| Before connecting any calendar | `connect-disclosure.html`, shown before the OAuth window opens. Continue is disabled until the checkbox is ticked. | `connection_disclosures` table + `trg_require_disclosure`. A connection row without a current acknowledgement is rejected by Postgres. |
| Every time a write is attempted on a read-only source | `NotWritableError.userMessage`, rendered in the panel | `assertWritable()` throws before any provider API call |
| When choosing where a confirmed event goes | Only writable calendars appear | `writableTargets()` |
| Permanently, while the app is open | Panel footer | `sidepanel.html`, not dismissible |

Disclosure copy comes from `CAPABILITIES[provider].disclosure` in
`src/providers/capabilities.ts`. Change it there, bump `DISCLOSURE_VERSION`, and bump
`pcc_current_disclosure_version()` in `db/schema.sql` to match — users then re-acknowledge on
their next connect.

## App-store / listing copy

Chrome Web Store and App Store listings should carry the same three lines the connect screen
does, since some users read a listing and nothing else:

- Reads your Google, Outlook, and course calendars. Nothing is created, moved, or deleted
  until you confirm it.
- Canvas and Blackboard course feeds are read-only. They can't be changed from here.
- This uses AI, which can misread dates on photos and messy event notes. Verify anything
  that matters.
