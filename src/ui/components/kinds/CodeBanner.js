// @ts-check
// PLACEHOLDER (WP0b): the code review's banner (WP4): "Files changed since vN: Re-snapshot" (CODE_TESTID.resnapshot;
// actions.js recordWorkingCopy -> POST D/record) while ds.working.dirty (ds.working.changedFiles lists the files, from
// the code poller's working.changed). It replaces the banner stack, so it renders <Banners /> (../Banners.js) under
// its own banner.
// Renders nothing until it is replaced; the kind seam (./index.js) already mounts it with the current DocState.

/** @param {{ ds: any }} _props */
export function CodeBanner(_props) {
  return null;
}
