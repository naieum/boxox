/**
 * Box Ox is single-tenant: one install is one organization, and the worker's
 * org-scoped API is addressed with this fixed id until p1-schema drops the
 * org scope.
 */
export const ORG_ID = "default";
