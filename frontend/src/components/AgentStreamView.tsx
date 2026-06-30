import { useState, useEffect, useRef } from "react";

interface StreamLine {
  type: "token" | "reasoning" | "tool_call" | "tool_result" | "turn" | "system" | "error";
  text: string;
  ts?: number;
}

function formatToolCall(text: string) {
  const parenIdx = text.indexOf("(");
  if (parenIdx === -1) return { name: text, args: "" };
  const name = text.slice(0, parenIdx);
  let args = text.slice(parenIdx + 1, text.lastIndexOf(")"));
  if (args.endsWith("...")) args = args.slice(0, -3);
  try {
    const parsed = JSON.parse(args);
    args = JSON.stringify(parsed, null, 2);
  } catch {}
  return { name, args };
}

const TOOL_ICONS: Record<string, string> = {
  memory_recall: "\uD83D\uDD0D",
  screen: "\uD83D\uDCCA",
  read_file: "\uD83D\uDCC4",
  write_file: "\u270D\uFE0F",
  bash: "\uD83D\uDCBB",
  web_search: "\uD83C\uDD0E",
  default: "\u2699\uFE0F",
};

function getToolIcon(name: string): string {
  return TOOL_ICONS[name] || TOOL_ICONS.default;
}

function getToken(): string | null {
  try { return localStorage.getItem("auth-token"); } catch { return null; }
}

export default function AgentStreamView({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const [status, setStatus] = useState<"connecting" | "streaming" | "done" | "error">("connecting");
  const [elapsed, setElapsed] = useState(0);
  const [currReasoning, setCurrReasoning] = useState("");
  const [currTool, setCurrTool] = useState<{ name: string; args: string } | null>(null);
  const [currToolResult, setCurrToolResult] = useState("");
  const [turns, setTurns] = useState<Array<{ turn: number; reasoning: string; toolCalls: Array<{ name: string; args: string; result: string }>; output: string }>>([]);
  const [currOutput, setCurrOutput] = useState("");
  const [currentTurn, setCurrentTurn] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reasoningTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const reasoningBuf = useRef("");
  const outputBuf = useRef("");

  useEffect(() => {
    let aborted = false;
    let elapTimer: ReturnType<typeof setInterval> | null = null;

    async function connect() {
      const token = getToken();
      const url = "/api/scheduler/agent-stream/" + taskId;

      try {
        const resp = await fetch(url, {
          headers: {
            "Accept": "text/event-stream",
            ...(token ? { "Authorization": "Bearer " + token } : {}),
          },
        });
        if (!resp.ok) { setStatus("error"); onDone(); return; }
        if (aborted) return;

        setStatus("streaming");
        elapTimer = setInterval(() => setElapsed(p => p + 1), 1000);

        // Flush reasoning every 500ms
        reasoningTimer.current = setInterval(() => {
          if (reasoningBuf.current) {
            setCurrReasoning(reasoningBuf.current);
          }
          if (outputBuf.current) {
            setCurrOutput(outputBuf.current);
          }
        }, 500);

        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        let currentEvent = "";
        let currentData = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (aborted) { reader.cancel(); return; }

          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event: ")) { currentEvent = line.slice(7).trim(); }
            else if (line.startsWith("data: ")) { currentData = line.slice(6).trim(); }
            else if (line === "" && currentEvent && currentData) {
              try {
                const d = JSON.parse(currentData);
                switch (currentEvent) {
                  case "connected": break;
                  case "token": outputBuf.current += d.token; break;
                  case "reasoning": reasoningBuf.current += d.token; break;
                  case "tool_call": {
                    // Flush reasoning buffer to current turn
                    const finalReasoning = reasoningBuf.current;
                    reasoningBuf.current = "";
                    if (finalReasoning) setCurrReasoning(finalReasoning);
                    const args = d.arguments || "";
                    const argsTrunc = args.length > 200 ? args.slice(0, 200) + "..." : args;
                    setCurrTool({ name: d.name, args: argsTrunc });
                    setCurrToolResult("");
                    break;
                  }
                  case "tool_result": {
                    const snippet = d.content.length > 150 ? d.content.slice(0, 150) + "..." : d.content;
                    setCurrToolResult(snippet);
                    // Add to current turn's tool calls list
                    if (currTool) {
                      setTurns(prev => {
                        const next = [...prev];
                        const idx = next.length - 1;
                        if (idx >= 0) {
                          const t = { ...next[idx] };
                          t.toolCalls = [...t.toolCalls, { name: currTool.name, args: currTool.args, result: snippet }];
                          next[idx] = t;
                        }
                        return next;
                      });
                    }
                    break;
                  }
                  case "turn": {
                    // Flush buffers
                    const finalReasoning = reasoningBuf.current;
                    const finalOutput = outputBuf.current;
                    reasoningBuf.current = "";
                    outputBuf.current = "";
                    setCurrReasoning(finalReasoning);
                    setCurrOutput(finalOutput);
                    setCurrTool(null);
                    setCurrToolResult("");
                    const turnNum = d.turn;
                    setCurrentTurn(turnNum);
                    setTurns(prev => [...prev, { turn: turnNum, reasoning: finalReasoning, toolCalls: [], output: finalOutput }]);
                    break;
                  }
                  case "done": {
                    const finalReasoning = reasoningBuf.current;
                    const finalOutput = outputBuf.current;
                    reasoningBuf.current = "";
                    outputBuf.current = "";
                    setCurrReasoning(finalReasoning);
                    setCurrOutput(finalOutput);
                    setTurns(prev => {
                      const next = [...prev];
                      if (next.length > 0) {
                        const idx = next.length - 1;
                        next[idx] = { ...next[idx], reasoning: finalReasoning, output: finalOutput };
                      }
                      return next;
                    });
                    setStatus("done");
                    onDone();
                    break;
                  }
                  case "error": {
                    setStatus("error");
                    onDone();
                    break;
                  }
                }
              } catch {}
              currentEvent = "";
              currentData = "";
            }
          }
        }
      } catch (err: any) {
        if (!aborted) { setStatus("error"); onDone(); }
      }
    }

    connect();
    return () => {
      aborted = true;
      if (elapTimer) clearInterval(elapTimer);
      if (reasoningTimer.current) clearInterval(reasoningTimer.current);
    };
  }, [taskId, onDone]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns, currReasoning, currTool, currToolResult, currOutput]);

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m${sec}s` : `${sec}s`;
  };

  return (
    <div className="rounded-lg overflow-hidden border border-bronze-dim/20" style={{ background: "#0d0d14" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-bronze-dim/10" style={{ background: "linear-gradient(90deg, rgba(180,130,70,0.08), transparent)" }}>
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full" style={{
            background: status === "streaming" ? "#e8b84b" : status === "done" ? "#4ade80" : status === "error" ? "#ef4444" : "#e8b84b",
            boxShadow: status === "streaming" ? "0 0 6px #e8b84b66" : "none"
          }} />
          <span className="text-sm font-medium" style={{ color: "#c8b080" }}>Agent 分析</span>
          {status === "streaming" && (
            <span className="text-xs" style={{ color: "#a09070" }}>
              &#9679; 运行中 {fmtTime(elapsed)}
            </span>
          )}
          {status === "done" && <span className="text-xs text-green-500">&#9679; 完成</span>}
          {status === "error" && <span className="text-xs text-red-400">&#9679; 出错</span>}
          {status === "connecting" && <span className="text-xs" style={{ color: "#a09070" }}>连接中...</span>}
        </div>
        <span className="text-xs font-mono" style={{ color: "#6b5d48" }}>Turn {currentTurn}</span>
      </div>

      {/* Body */}
      <div ref={scrollRef} className="overflow-y-auto px-4 py-3 space-y-3" style={{ maxHeight: "420px", background: "#0d0d14" }}>
        {turns.length === 0 && !currReasoning && !currTool && status === "streaming" && (
          <div className="text-xs animate-pulse" style={{ color: "#6b5d48" }}>等待 Agent 开始分析...</div>
        )}

        {/* Render completed turns */}
        {turns.map((turn, ti) => (
          <div key={ti} className="space-y-2">
            {/* Turn header */}
            <div className="flex items-center gap-2 text-xs" style={{ color: "#6b5d48" }}>
              <span>─ Turn {turn.turn} ─</span>
              <div className="flex-1 h-px" style={{ background: "linear-gradient(90deg, rgba(107,93,72,0.3), transparent)" }} />
            </div>

            {/* Reasoning */}
            {turn.reasoning && (
              <div className="text-xs leading-relaxed" style={{ color: "#7a7a8a" }}>
                {turn.reasoning}
              </div>
            )}

            {/* Tool calls */}
            {turn.toolCalls.map((tc, tci) => (
              <div key={tci} className="rounded-lg overflow-hidden border" style={{ borderColor: "rgba(180,130,70,0.12)", background: "rgba(180,130,70,0.04)" }}>
                <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono" style={{ background: "rgba(180,130,70,0.06)", color: "#c8b080" }}>
                  <span>{getToolIcon(tc.name)}</span>
                  <span className="font-medium">{tc.name}</span>
                  {tc.args && tc.args.length < 80 && <span className="truncate" style={{ color: "#8a7a60" }}>{tc.args}</span>}
                </div>
                {tc.result && (
                  <div className="px-3 py-2 text-xs font-mono leading-relaxed" style={{ color: "#6a7a6a", background: "rgba(74,222,128,0.04)" }}>
                    {tc.result}
                  </div>
                )}
              </div>
            ))}

            {/* Output */}
            {turn.output && (
              <div className="px-3 py-2 rounded text-xs leading-relaxed" style={{ color: "#c8c090", background: "rgba(200,176,128,0.05)" }}>
                {turn.output}
              </div>
            )}
          </div>
        ))}

        {/* Live section - currently streaming */}
        {status === "streaming" && (
          <div className="space-y-2 animate-pulse" style={{ animationDuration: "2s" }}>
            {/* Turn header for live turn */}
            {turns.length > 0 && (
              <div className="flex items-center gap-2 text-xs" style={{ color: "#6b5d48" }}>
                <span>─ Turn {currentTurn + 1} ─</span>
                <div className="flex-1 h-px" style={{ background: "linear-gradient(90deg, rgba(107,93,72,0.3), transparent)" }} />
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#e8b84b", boxShadow: "0 0 4px #e8b84b66" }} />
              </div>
            )}
            {currReasoning && (
              <div className="text-xs leading-relaxed" style={{ color: "#7a7a8a" }}>
                {currReasoning}
              </div>
            )}
            {currTool && (
              <div className="rounded-lg overflow-hidden border" style={{ borderColor: "rgba(180,130,70,0.15)", background: "rgba(180,130,70,0.04)" }}>
                <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono" style={{ background: "rgba(180,130,70,0.06)", color: "#c8b080" }}>
                  <span>{getToolIcon(currTool.name)}</span>
                  <span className="font-medium">{currTool.name}</span>
                  <span className="truncate" style={{ color: "#8a7a60" }}>{currTool.args}</span>
                </div>
                {currToolResult && (
                  <div className="px-3 py-2 text-xs font-mono leading-relaxed" style={{ color: "#6a7a6a", background: "rgba(74,222,128,0.04)" }}>
                    {currToolResult}
                  </div>
                )}
                {!currToolResult && (
                  <div className="px-3 py-2 text-xs" style={{ color: "#5a5a6a" }}>
                    <span className="inline-block w-2 h-3 ml-0.5" style={{ background: "#e8b84b", boxShadow: "0 0 4px #e8b84b66" }} />
                  </div>
                )}
              </div>
            )}
            {currOutput && (
              <div className="px-3 py-2 rounded text-xs leading-relaxed" style={{ color: "#c8c090", background: "rgba(200,176,128,0.05)" }}>
                {currOutput}
              </div>
            )}
            {!currReasoning && !currTool && !currOutput && (
              <div className="flex items-center gap-1 text-xs" style={{ color: "#5a5a6a" }}>
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500/50" style={{ boxShadow: "0 0 4px #e8b84b66", animation: "pulse 1s infinite" }} />
                <span>分析中</span>
              </div>
            )}
          </div>
        )}

        {/* Done state */}
        {status === "done" && turns.length > 0 && (
          <div className="flex items-center gap-2 pt-2 text-xs" style={{ color: "#4ade80" }}>
            <span>&#10003;</span>
            <span>分析完成 &#8212; {turns.reduce((s, t) => s + t.toolCalls.length, 0)} 次工具调用</span>
          </div>
        )}

        {/* Error state */}
        {status === "error" && (
          <div className="text-xs text-red-400">&#10007; 分析出错</div>
        )}
      </div>
    </div>
  );
}
