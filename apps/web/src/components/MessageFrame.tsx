import DOMPurify from "dompurify";
import { useMemo } from "react";
import { FRAME_SANDBOX, frameDocument, hasBlockedImages, proxiedImageSrc } from "./MessageFrame.policy";

const purify = DOMPurify(window);
let revealImages = false;

// The server already sanitized and signed everything; this is the second layer.
purify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  if (node.tagName === "IMG") {
    const proxied = proxiedImageSrc(node.getAttribute("data-boxox-src"));
    const src = node.getAttribute("src");
    if (src && /^(https?:)?\/\//i.test(src)) node.removeAttribute("src");
    if (revealImages && proxied) node.setAttribute("src", proxied);
  }
});

function sanitize(html: string, showRemote: boolean): string {
  revealImages = showRemote;
  return purify.sanitize(html, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "meta", "base", "link", "svg", "math"],
    FORBID_ATTR: ["srcset", "srcdoc", "action", "formaction", "background", "ping"],
    ADD_ATTR: ["target"],
  });
}

export { hasBlockedImages };

/** Mail HTML in a script-less sandboxed frame; remote images only through the proxy, and only when allowed. */
export function MessageFrame({ html, showRemote }: { html: string; showRemote: boolean }) {
  const doc = useMemo(
    () => frameDocument(sanitize(html, showRemote), { origin: window.location.origin, showRemote }),
    [html, showRemote],
  );
  return <iframe sandbox={FRAME_SANDBOX} referrerPolicy="no-referrer" title="message" className="min-h-[220px] w-full rounded-lg bg-white" srcDoc={doc} />;
}
