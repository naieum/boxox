// Current product versions. Archived manifests and artifact bytes remain immutable.
export const APP_VERSION = '2.4.8';
export const EMAIL_SKILL_VERSION = '0.4.1';
export const BRAND_ASSETS_VERSION = '1.1.1';
export const RELEASE_DATE = '2026-10-23';
export const WITHDRAWN_SOURCE_RELEASES = ['2.0.0', '2.0.1', '2.1.0', '2.1.1', '2.1.2', '2.2.0', '2.3.0', '2.4.0', '2.4.1', '2.4.2', '2.4.3', '2.4.4'];
// Packages whose bundled license notice named a person. Replaced by email skill 0.4.1.
export const WITHDRAWN_ARTIFACTS = ['boxox-email-skill-0.1.0.zip', 'boxox-email-skill-0.2.0.zip', 'boxox-email-skill-0.3.0.zip', 'boxox-email-skill-0.4.0.zip'];
// Earlier releases that remain downloadable in full.
export const PREVIOUS_RELEASES = ['2.4.5', '2.4.6', '2.4.7'];
export const RELEASES = [...WITHDRAWN_SOURCE_RELEASES, ...PREVIOUS_RELEASES, APP_VERSION];
