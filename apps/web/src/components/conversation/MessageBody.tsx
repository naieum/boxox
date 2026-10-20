import { useState } from "react";
import { hasBlockedImages, MessageFrame } from "../MessageFrame";
import type { ConversationMessage } from "./api";

function QuoteToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={open ? "Hide quoted text" : "Show quoted text"}
      aria-expanded={open}
      onClick={onClick}
      className="mt-2 inline-flex h-[18px] items-center rounded-[5px] bg-white/8 px-2 text-[13px] leading-none font-bold tracking-[0.1em] text-[#9BA1AD] hover:bg-white/14 hover:text-foreground"
    >
      …
    </button>
  );
}

export function MessageBody({ message }: { message: ConversationMessage }) {
  const [showRemote, setShowRemote] = useState(false);
  const [showQuoted, setShowQuoted] = useState(false);
  const html = message.html ? (showQuoted && message.quotedHtml ? message.html + message.quotedHtml : message.html) : null;
  const hasRemote = html ? hasBlockedImages(html) : false;

  if (html) {
    return (
      <div>
        {hasRemote && !showRemote && (
          <div className="mb-3 flex flex-wrap items-center gap-2.5 rounded-lg border border-white/10 bg-white/4 px-3 py-2 text-[12.5px] text-[#9BA1AD]">
            <span>Remote images are blocked to protect your privacy.</span>
            <button
              onClick={() => setShowRemote(true)}
              className="ml-auto rounded-md bg-white/8 px-2.5 py-1 text-[12px] font-semibold text-foreground hover:bg-white/12"
            >
              Load images
            </button>
          </div>
        )}
        <MessageFrame html={html} showRemote={showRemote} />
        {message.quotedHtml && <QuoteToggle open={showQuoted} onClick={() => setShowQuoted((v) => !v)} />}
      </div>
    );
  }
  return (
    <div>
      <div className="text-[14.5px] leading-[1.72] whitespace-pre-wrap text-[#C9CFD8]">
        {message.text ?? message.snippet}
      </div>
      {message.quotedText && (
        <>
          <QuoteToggle open={showQuoted} onClick={() => setShowQuoted((v) => !v)} />
          {showQuoted && (
            <div className="mt-2 border-l-2 border-white/10 pl-3 text-[13.5px] leading-[1.65] whitespace-pre-wrap text-[#8b919c]">
              {message.quotedText}
            </div>
          )}
        </>
      )}
    </div>
  );
}
