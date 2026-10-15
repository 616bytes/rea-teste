# Read-only browser UI state transitions

`derive_ui_state_transition` / `derive-ui-state-transition` derives one
bounded browser-page state pair from completed `inspect_web_page` Evidence.
It never opens CDP, invokes a browser action, resets target state, or embeds a
second browser engine.

Capture the page before an external action, arm `observe_web_session` when a
bounded event window is useful, execute the action outside REA, then capture
the page again. Pyppeteer may be that external executor on Linux or Windows.
The action is supplied as `provenance: "caller-declared"` with
`executor: "external"`; REA does not promote it to an observed or causal
event.

The projection pages retained accessibility role/name/state records for both
states, keeps DOM counts and source completeness, and reuses the existing
passive web-capture comparison for non-causal observed differences. Optional
`observe_web_session` Evidence is linked only when its target matches both
page observations. Additional Evidence references remain caller-linked context:
the adapter does not infer static, IPC, network, process, filesystem, or action
causality from them.

State references are exact source Evidence IDs, not invented stable UI IDs:
CDP target and accessibility node IDs are capture-local. Missing or truncated
accessibility data, different target/origin pairs, visual visibility,
clickability, unvisited candidates, unreachable candidates, arbitrary native
windows, Electron accessibility state, screenshots, and reset determinism all
remain explicitly unknown or out of scope for browser-page v1.
