// dsh-pin host entry.
//
// All pinning behavior lives in the browser client: workspace order updates go
// through the Host's existing `workspaces.insertBefore` RPC, and panel pin
// choices are browser-local. The host half exists only so the profile bundle
// can mount one Loader row.
export function apply() {}
