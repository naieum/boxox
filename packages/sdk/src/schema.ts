// Generated from docs/api/openapi.json by `pnpm --filter @boxox/mail generate`. Do not edit.

export interface paths {
    "/dev/v1/keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Domain keys on the management key's domains */
        get: operations["listKeys"];
        put?: never;
        /** Create a domain key (management keys only) */
        post: operations["createKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/keys/{id}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke a domain key at once */
        post: operations["revokeKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/keys/{id}/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Issue a new secret; the old one works for the overlap window */
        post: operations["rotateKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Message log, newest first (needs `read_log`) */
        get: operations["listMessages"];
        put?: never;
        /** Send or schedule one message (needs `send`) */
        post: operations["sendMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/messages/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One message with its status timeline and rendered body (needs `read_log`) */
        get: operations["getMessage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Move a scheduled message's send time (needs `send`) */
        patch: operations["rescheduleMessage"];
        trace?: never;
    };
    "/dev/v1/messages/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel a scheduled message (needs `send`) */
        post: operations["cancelMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/messages/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Send up to 100 messages, all-or-nothing or partial (needs `send`) */
        post: operations["sendBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/received": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Mail received on the domain's app inboxes (needs `read_received`) */
        get: operations["listReceived"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/received/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Parsed fields, authentication, bodies and attachments */
        get: operations["getReceived"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/received/{id}/attachments/{attachmentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Download one attachment */
        get: operations["getReceivedAttachment"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/received/{id}/raw": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A signed, expiring link to the original .eml */
        get: operations["getReceivedRawUrl"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/received/raw/{token}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The signed .eml link itself; no API key, the token is the credential */
        get: operations["downloadReceivedRaw"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/suppressions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The domain's suppression list (needs `read_log`) */
        get: operations["listSuppressions"];
        put?: never;
        /** Suppress an address (needs `send`) */
        post: operations["addSuppression"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/suppressions/{email}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Whether one address is suppressed */
        get: operations["getSuppression"];
        put?: never;
        post?: never;
        /** Remove an address from our list (Cloudflare's still applies) */
        delete: operations["removeSuppression"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Latest version of each template (needs `templates`) */
        get: operations["listTemplates"];
        put?: never;
        /** Create a template at version 1 */
        post: operations["createTemplate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/templates/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The latest version, or ?version= */
        get: operations["getTemplate"];
        /** Save a new version */
        put: operations["updateTemplate"];
        post?: never;
        /** Delete every version */
        delete: operations["deleteTemplate"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/templates/{name}/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Render with sample variables */
        post: operations["previewTemplate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/templates/{name}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Every version, newest first */
        get: operations["listTemplateVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/webhooks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Endpoints on the key's domain */
        get: operations["listWebhooks"];
        put?: never;
        /** Add an HTTPS endpoint (needs `webhooks`) */
        post: operations["createWebhook"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/webhooks/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One endpoint */
        get: operations["getWebhook"];
        put?: never;
        post?: never;
        /** Delete an endpoint */
        delete: operations["deleteWebhook"];
        options?: never;
        head?: never;
        /** Change the URL or events, or enable/disable */
        patch: operations["updateWebhook"];
        trace?: never;
    };
    "/dev/v1/webhooks/{id}/deliveries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Delivery log, newest first */
        get: operations["listWebhookDeliveries"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/webhooks/{id}/deliveries/{deliveryId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One delivery with its attempt log and payload */
        get: operations["getWebhookDelivery"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/webhooks/{id}/deliveries/{deliveryId}/replay": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Send a finished delivery again */
        post: operations["replayWebhookDelivery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/webhooks/{id}/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** New signing secret; both sign during the overlap */
        post: operations["rotateWebhookSecret"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/webhooks/{id}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Send a webhook.test event */
        post: operations["testWebhook"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dev/v1/webhooks/listen": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Live events on the key's domain over a WebSocket, for local development */
        get: operations["listenWebhooks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export interface webhooks {
    event: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** An event delivered to your endpoint, signed with the endpoint's whsec_ secret */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["WebhookEvent"];
                };
            };
            responses: {
                /** @description Any 2xx acknowledges the delivery */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export interface components {
    schemas: {
        AddSuppressionRequest: {
            detail?: string;
            /** Format: email */
            email: string;
        };
        AttemptLogEntry: {
            /** Format: date-time */
            at: string;
            durationMs: number;
            error?: string;
            replay?: boolean;
            status: number | null;
        };
        BatchRejected: {
            error: {
                /** @constant */
                code: "batch_rejected";
                message: string;
            };
            errors: {
                code: string;
                index: number;
                message: string;
                param?: string;
            }[];
        };
        BatchRequest: {
            messages: {
                attachments?: {
                    content: string;
                    contentId?: string;
                    contentType?: string;
                    filename: string;
                }[];
                bcc?: string | string[];
                cc?: string | string[];
                from: string;
                headers?: {
                    [key: string]: string;
                };
                html?: string;
                replyTo?: string;
                /** Format: date-time */
                sendAt?: string;
                subject?: string;
                tags?: {
                    [key: string]: string;
                };
                template?: string | {
                    name: string;
                    version?: number;
                };
                text?: string;
                to: string | string[];
                track?: {
                    clicks?: boolean;
                    opens?: boolean;
                };
                variables?: {
                    [key: string]: unknown;
                };
            }[];
            /**
             * @default all_or_nothing
             * @enum {string}
             */
            mode?: "all_or_nothing" | "partial";
        };
        BatchResult: {
            data: {
                id: string;
                index: number;
                scheduledAt: string | null;
                /** @enum {string} */
                status: "queued" | "scheduled" | "failed";
            }[];
            errors: {
                code: string;
                index: number;
                message: string;
                param?: string;
            }[];
        };
        CancelResult: {
            id: string;
            /** @constant */
            status: "canceled";
        };
        /** @description The full secret appears only in this response. */
        CreatedKey: {
            key: components["schemas"]["DomainKey"];
            secret: string;
        };
        CreateKeyRequest: {
            allowedFrom?: string[];
            allowedRecipients?: string[];
            dailySendCap?: number | null;
            domain: string;
            expiresAt?: string | null;
            ipAllowlist?: string[];
            /** @constant */
            kind?: "domain";
            name: string;
            permissions: ("send" | "read_log" | "read_received" | "templates" | "webhooks")[];
            rateLimitPerMinute?: number | null;
        };
        CreateTemplateRequest: {
            html?: string | null;
            name: string;
            /** @default  */
            subject?: string;
            text?: string | null;
            /** @default [] */
            variables?: {
                fallback?: string | number | boolean;
                name: string;
                /** @default false */
                raw?: boolean;
                /**
                 * @default string
                 * @enum {string}
                 */
                type?: "string" | "number" | "boolean" | "url";
            }[];
        };
        CreateWebhookRequest: {
            events?: ("message.sent" | "message.delivered" | "message.deferred" | "message.bounced" | "message.complained" | "message.failed" | "message.opened" | "message.clicked" | "message.received")[];
            url: string;
        };
        DeliveryDetail: components["schemas"]["WebhookDelivery"] & {
            attemptLog: components["schemas"]["AttemptLogEntry"][];
            payload: unknown;
        };
        DomainKey: {
            allowedFrom: string[];
            allowedRecipients: string[];
            /** Format: date-time */
            createdAt: string;
            createdBy: string;
            dailySendCap: number | null;
            display: string;
            domainId: string | null;
            expiresAt: string | null;
            id: string;
            ipAllowlist: string[];
            /** @enum {string} */
            kind: "management" | "domain";
            lastUsedAt: string | null;
            lastUsedIp: string | null;
            name: string;
            parentKeyId: string | null;
            permissions: ("send" | "read_log" | "read_received" | "templates" | "webhooks")[];
            rateLimitPerMinute: number | null;
            revokedAt: string | null;
            rotationEndsAt: string | null;
        };
        Error: {
            error: {
                code: string;
                message: string;
                param?: string;
            };
        };
        MessageDetail: components["schemas"]["MessageSummary"] & {
            body: {
                attachments: {
                    contentId: string | null;
                    contentType: string;
                    filename: string;
                    size: number;
                }[];
                headers: {
                    [key: string]: string;
                };
                html: string | null;
                text: string;
            } | null;
            timeline: {
                /** Format: date-time */
                at: string;
                detail: {
                    [key: string]: unknown;
                } | null;
                recipient: string | null;
                /** @enum {string} */
                type: "queued" | "scheduled" | "sent" | "delivered" | "deferred" | "bounced" | "complained" | "failed" | "rejected" | "opened" | "clicked" | "canceled";
            }[];
        };
        MessageSummary: {
            bcc: string[];
            cc: string[];
            /** Format: date-time */
            createdAt: string;
            error: string | null;
            from: string;
            id: string;
            replyTo: string[];
            scheduledAt: string | null;
            sentMessageId: string | null;
            /** @enum {string} */
            status: "queued" | "scheduled" | "sent" | "delivered" | "deferred" | "bounced" | "complained" | "failed" | "canceled";
            subject: string;
            tags: {
                [key: string]: string;
            };
            to: string[];
            /** Format: date-time */
            updatedAt: string;
        };
        PreviewTemplateRequest: {
            variables?: {
                [key: string]: unknown;
            };
            version?: number;
        };
        QueuedMessage: {
            id: string;
            scheduledAt: string | null;
            /** @enum {string} */
            status: "queued" | "scheduled" | "failed";
        };
        RawDownload: {
            /** Format: date-time */
            expiresAt: string;
            /** Format: uri */
            url: string;
        };
        ReceivedAttachment: {
            contentId: string | null;
            declaredType: string | null;
            detectedType: string;
            filename: string;
            id: string;
            inline: boolean;
            /** @enum {string} */
            risk: "safe" | "previewable" | "dangerous";
            size: number;
        };
        ReceivedEmail: {
            ccEmails: string[];
            from: {
                email: string;
                name?: string;
            };
            id: string;
            /** @constant */
            object: "received_email";
            /** Format: date-time */
            receivedAt: string;
            snippet: string;
            spam: boolean;
            subject: string;
            to: string;
            toEmails: string[];
        };
        ReceivedEmailDetail: components["schemas"]["ReceivedEmail"] & {
            attachments: components["schemas"]["ReceivedAttachment"][];
            authentication: {
                authenticated: boolean;
            };
            hasRaw: boolean;
            html: string | null;
            inReplyTo: string | null;
            messageId: string | null;
            references: string | null;
            text: string | null;
        };
        RescheduleRequest: {
            /** Format: date-time */
            sendAt: string;
        };
        RescheduleResult: {
            id: string;
            /** Format: date-time */
            scheduledAt: string;
            /** @enum {string} */
            status: "scheduled" | "failed";
        };
        RevokeResult: {
            revoked: string[];
        };
        RotateKeyRequest: {
            overlapHours?: number;
        };
        RotateWebhookRequest: {
            overlapHours?: number;
        };
        SendMessageRequest: {
            attachments?: {
                content: string;
                contentId?: string;
                contentType?: string;
                filename: string;
            }[];
            bcc?: string | string[];
            cc?: string | string[];
            from: string;
            headers?: {
                [key: string]: string;
            };
            html?: string;
            replyTo?: string;
            /** Format: date-time */
            sendAt?: string;
            subject?: string;
            tags?: {
                [key: string]: string;
            };
            template?: string | {
                name: string;
                version?: number;
            };
            text?: string;
            to: string | string[];
            track?: {
                clicks?: boolean;
                opens?: boolean;
            };
            variables?: {
                [key: string]: unknown;
            };
        };
        Suppression: {
            /** Format: date-time */
            createdAt: string;
            detail: string | null;
            email: string;
            id: string;
            /** @constant */
            object: "suppression";
            /** @enum {string} */
            reason: "bounce" | "complaint" | "manual";
        };
        SuppressionDeleted: {
            /** @constant */
            deleted: true;
            email: string;
            id: string;
            /** @constant */
            object: "suppression";
        };
        Template: {
            /** Format: date-time */
            createdAt: string;
            createdBy: string;
            html: string | null;
            id: string;
            name: string;
            subject: string;
            text: string | null;
            variables: {
                fallback?: string | number | boolean;
                name: string;
                /** @default false */
                raw?: boolean;
                /**
                 * @default string
                 * @enum {string}
                 */
                type?: "string" | "number" | "boolean" | "url";
            }[];
            version: number;
        };
        TemplateDeleted: {
            /** @constant */
            deleted: true;
            name: string;
            versions: number;
        };
        TemplatePreview: {
            html: string | null;
            name: string;
            subject: string;
            text: string;
            version: number;
        };
        TemplateVariable: {
            fallback?: string | number | boolean;
            name: string;
            /** @default false */
            raw?: boolean;
            /**
             * @default string
             * @enum {string}
             */
            type?: "string" | "number" | "boolean" | "url";
        };
        UpdateTemplateRequest: {
            html?: string | null;
            /** @default  */
            subject?: string;
            text?: string | null;
            /** @default [] */
            variables?: {
                fallback?: string | number | boolean;
                name: string;
                /** @default false */
                raw?: boolean;
                /**
                 * @default string
                 * @enum {string}
                 */
                type?: "string" | "number" | "boolean" | "url";
            }[];
        };
        UpdateWebhookRequest: {
            enabled?: boolean;
            events?: ("message.sent" | "message.delivered" | "message.deferred" | "message.bounced" | "message.complained" | "message.failed" | "message.opened" | "message.clicked" | "message.received")[];
            url?: string;
        };
        Webhook: {
            consecutiveFailures: number;
            /** Format: date-time */
            createdAt: string;
            disabledAt: string | null;
            events: ("message.sent" | "message.delivered" | "message.deferred" | "message.bounced" | "message.complained" | "message.failed" | "message.opened" | "message.clicked" | "message.received")[];
            id: string;
            previousSecretExpiresAt: string | null;
            /** @enum {string} */
            status: "active" | "disabled";
            /** Format: date-time */
            updatedAt: string;
            url: string;
        };
        WebhookDeleted: {
            /** @constant */
            deleted: true;
            id: string;
        };
        WebhookDelivery: {
            attempts: number;
            /** Format: date-time */
            createdAt: string;
            deliveredAt: string | null;
            eventId: string;
            eventType: string;
            id: string;
            lastStatusCode: number | null;
            nextAttemptAt: string | null;
            /** @enum {string} */
            status: "pending" | "succeeded" | "failed";
            webhookId: string;
        };
        /** @description The signed JSON body POSTed to a webhook endpoint (Standard Webhooks headers webhook-id, webhook-timestamp, webhook-signature). */
        WebhookEvent: {
            data: {
                [key: string]: unknown;
            };
            /** Format: date-time */
            timestamp: string;
            type: components["schemas"]["WebhookEventType"];
        };
        /** @enum {string} */
        WebhookEventType: "message.sent" | "message.delivered" | "message.deferred" | "message.bounced" | "message.complained" | "message.failed" | "message.opened" | "message.clicked" | "message.received" | "webhook.test";
        /** @description One event sent to `GET /dev/v1/webhooks/listen`. `payload` is the WebhookEvent JSON exactly as an endpoint would receive it. */
        WebhookListenFrame: {
            id: string;
            payload: string;
        };
        WebhookTestResult: {
            deliveryId?: string;
        };
        WebhookWithSecret: components["schemas"]["Webhook"] & {
            /** @description whsec_… signing secret; shown only on create and rotate. */
            secret: string;
        };
    };
    responses: {
        /** @description Invalid request */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description The key may not do this */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Not found on this key's domain */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Missing or invalid API key */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
    };
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listKeys: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: components["schemas"]["DomainKey"][];
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    createKey: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateKeyRequest"];
            };
        };
        responses: {
            /** @description Created; the secret is shown once */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreatedKey"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    revokeKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RevokeResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    rotateKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["RotateKeyRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreatedKey"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    listMessages: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                recipient?: string;
                status?: "queued" | "scheduled" | "sent" | "delivered" | "deferred" | "bounced" | "complained" | "failed" | "canceled";
                tag?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: components["schemas"]["MessageSummary"][];
                        nextCursor: string | null;
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    sendMessage: {
        parameters: {
            query?: never;
            header?: {
                /** @description Replays within 24 h return the original response; a different body gets 409. */
                "Idempotency-Key"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SendMessageRequest"];
            };
        };
        responses: {
            /** @description Queued or scheduled */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QueuedMessage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description Idempotency-Key conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Rate limit or daily cap reached */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MessageDetail"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    rescheduleMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RescheduleRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RescheduleResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description Not scheduled any more */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    cancelMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CancelResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description Not scheduled any more */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    sendBatch: {
        parameters: {
            query?: never;
            header?: {
                /** @description Replays within 24 h return the original response; a different body gets 409. */
                "Idempotency-Key"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BatchRequest"];
            };
        };
        responses: {
            /** @description Queued; `errors` lists skipped messages in partial mode */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description Idempotency-Key conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No message was sent */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchRejected"];
                };
            };
            /** @description Rate limit or daily cap reached */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listReceived: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                to?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: components["schemas"]["ReceivedEmail"][];
                        nextCursor: string | null;
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getReceived: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReceivedEmailDetail"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getReceivedAttachment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attachmentId: string;
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The attachment bytes */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getReceivedRawUrl: {
        parameters: {
            query?: {
                expiresIn?: number;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RawDownload"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description Raw downloads are not configured */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    downloadReceivedRaw: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                token: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The original message */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "message/rfc822": string;
                };
            };
            /** @description Invalid or expired link */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listSuppressions: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                reason?: "bounce" | "complaint" | "manual";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: components["schemas"]["Suppression"][];
                        nextCursor: string | null;
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    addSuppression: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AddSuppressionRequest"];
            };
        };
        responses: {
            /** @description Suppressed */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Suppression"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getSuppression: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                email: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Suppression"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    removeSuppression: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                email: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SuppressionDeleted"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    listTemplates: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: components["schemas"]["Template"][];
                        nextCursor: string | null;
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    createTemplate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateTemplateRequest"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Template"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description A template with this name exists */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getTemplate: {
        parameters: {
            query?: {
                version?: number;
            };
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Template"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    updateTemplate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateTemplateRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Template"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    deleteTemplate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TemplateDeleted"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    previewTemplate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["PreviewTemplateRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TemplatePreview"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    listTemplateVersions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: components["schemas"]["Template"][];
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    listWebhooks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: components["schemas"]["Webhook"][];
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    createWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateWebhookRequest"];
            };
        };
        responses: {
            /** @description Created; the secret is shown once */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookWithSecret"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description URL not allowed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Webhook"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    deleteWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookDeleted"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    updateWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateWebhookRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Webhook"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description URL not allowed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listWebhookDeliveries: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                status?: "pending" | "succeeded" | "failed";
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: components["schemas"]["WebhookDelivery"][];
                        nextCursor: string | null;
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getWebhookDelivery: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                deliveryId: string;
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryDetail"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    replayWebhookDelivery: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                deliveryId: string;
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Queued */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookDelivery"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description Disabled or still pending */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    rotateWebhookSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["RotateWebhookRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookWithSecret"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    testWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Queued */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookTestResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description Webhook disabled */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listenWebhooks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Switching protocols; each text frame is a WebhookListenFrame */
            101: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description Not a WebSocket upgrade */
            426: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
}
