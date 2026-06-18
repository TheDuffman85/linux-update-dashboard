import { useRef, useEffect, useMemo } from "react";
import type { WsMessage } from "../hooks/useCommandOutput";
import { ContentExpansionButton, CopyButton, useContentExpansion } from "./CopyableCodeBlock";
import { TerminalText } from "./TerminalText";
import { useI18n } from "../lib/i18n";

interface TerminalOutputProps {
  messages: WsMessage[];
  isActive: boolean;
  phase: string | null;
  connected: boolean;
}

export function TerminalOutput({ messages, isActive, phase, connected }: TerminalOutputProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const isScrolledToBottom = useRef(true);
  const copyText = useMemo(() => {
    return messages.map((msg) => {
      switch (msg.type) {
        case "started":
          return `$ ${msg.command}\n`;
        case "output":
          return msg.data;
        case "phase":
          return `--- ${msg.phase === "rechecking" ? t("components.terminalOutput.recheckingForUpdates") : msg.phase} ---\n`;
        case "done":
          return `${msg.success ? t("components.terminalOutput.done") : t("components.terminalOutput.failed")}\n`;
        case "error":
          return `${t("components.terminalOutput.error")}: ${msg.message}\n`;
        case "warning":
          return `${t("components.terminalOutput.warning")}: ${msg.message}\n`;
        default:
          return "";
      }
    }).join("");
  }, [messages, t]);
  const {
    expanded,
    canExpand,
    toggleExpanded,
    expansionStyle,
  } = useContentExpansion(containerRef, copyText);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    isScrolledToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  };

  useEffect(() => {
    if (isScrolledToBottom.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages]);

  const lastStarted = [...messages]
    .reverse()
    .find((m): m is Extract<WsMessage, { type: "started" }> => m.type === "started");

  const lastDone = [...messages]
    .reverse()
    .find((m): m is Extract<WsMessage, { type: "done" }> => m.type === "done");

  let headerText = t("components.terminalOutput.commandOutput");
  if (phase === "reconnecting") {
    headerText = t("components.terminalOutput.reconnectingToRemoteServer");
  } else if (phase === "rechecking") {
    headerText = t("components.terminalOutput.recheckingForUpdates");
  } else if (isActive && lastStarted) {
    headerText = t("components.terminalOutput.runningCommand", { command: lastStarted.command });
  } else if (lastDone) {
    headerText = lastDone.success
      ? t("components.terminalOutput.completedSuccessfully")
      : t("components.terminalOutput.commandFailed");
  }

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-700 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-slate-400 truncate max-w-md">
            {headerText}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isActive && (
            <span className={`flex items-center gap-1.5 text-xs ${phase === "reconnecting" ? "text-amber-400" : "text-green-400"}`}>
              <span className="spinner spinner-sm !w-3 !h-3" />
              {phase === "reconnecting" ? t("components.terminalOutput.reconnecting") : t("components.terminalOutput.running")}
            </span>
          )}
          {!connected && (
            <span className="text-xs text-amber-400">{t("components.terminalOutput.disconnected")}</span>
          )}
          {canExpand && (
            <ContentExpansionButton
              expanded={expanded}
              onToggle={toggleExpanded}
              className="h-6 w-6"
            />
          )}
          <CopyButton
            text={copyText}
            className="h-6 w-6"
            successMessage="components.terminalOutput.copiedCommandOutput"
          />
        </div>
      </div>

      {/* Terminal body */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="p-4 font-mono text-xs leading-relaxed text-slate-300 max-h-96 overflow-y-auto whitespace-pre-wrap break-all"
        style={expansionStyle}
      >
        {messages.length === 0 && (
          <span className="text-slate-500 italic">
            {connected
              ? t("components.terminalOutput.waitingForOutput")
              : t("components.terminalOutput.waitingForOutputReconnecting")}
          </span>
        )}
        {messages.map((msg, i) => {
          switch (msg.type) {
            case "started":
              return (
                <div key={i} className="text-blue-400 mb-1">
                  $ {msg.command}
                </div>
              );
            case "output":
              return (
                <span key={i}>
                  <TerminalText text={msg.data} stream={msg.stream} />
                </span>
              );
            case "phase":
              return (
                <div key={i} className="text-yellow-400 mt-2 mb-1">
                  --- {msg.phase === "rechecking"
                    ? "Rechecking for updates..."
                    : msg.phase} ---
                </div>
              );
            case "done":
              return (
                <div
                  key={i}
                  className={`mt-2 font-semibold ${
                    msg.success ? "text-green-400" : "text-red-400"
                  }`}
                >
                  {msg.success ? "Done." : "Failed."}
                </div>
              );
            case "error":
              return (
                <div key={i} className="text-red-400">
                  Error: {msg.message}
                </div>
              );
            case "warning":
              return (
                <div key={i} className="text-amber-400 mt-2 mb-1">
                  Warning: {msg.message}
                </div>
              );
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}
