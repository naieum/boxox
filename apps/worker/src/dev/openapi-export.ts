import { documentedRoutes, mountedRoutes, openapiDocument } from "./openapi";

/** Run under Node (tsx) by packages/sdk/scripts/openapi.mjs: prints the spec and route lists as JSON. */
console.log(JSON.stringify({ document: openapiDocument(), mounted: mountedRoutes(), documented: documentedRoutes() }));
