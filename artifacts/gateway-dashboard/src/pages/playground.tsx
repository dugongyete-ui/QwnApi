import { useState, useRef, useEffect } from "react";
import { useSendChat, useListModels, getListModelsQueryKey } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Send, Terminal, Cpu, Trash2, ChevronDown, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

type LocalMessage = {
  role: "user" | "assistant";
  content: string;
  thinking?: string | null;
  timestamp: string;
  elapsed?: number;
};

function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2 border border-border/50 rounded-md overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-mono text-muted-foreground bg-muted/20 hover:bg-muted/40 transition-colors"
      >
        <span className="uppercase opacity-60">&gt; Thought Process</span>
        <ChevronDown className={cn("w-3 h-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-3 py-2 text-xs text-muted-foreground font-mono bg-muted/10 whitespace-pre-wrap">
          {content}
        </div>
      )}
    </div>
  );
}

function LoadingIndicator({ elapsed }: { elapsed: number }) {
  const isLong = elapsed >= 15;
  const isVeryLong = elapsed >= 45;

  return (
    <div className="p-3 rounded-md bg-muted border border-border text-foreground space-y-2">
      <div className="flex gap-1.5 items-center">
        <span className="animate-bounce inline-block w-1.5 h-1.5 bg-primary rounded-full" style={{ animationDelay: "0ms" }} />
        <span className="animate-bounce inline-block w-1.5 h-1.5 bg-primary rounded-full" style={{ animationDelay: "150ms" }} />
        <span className="animate-bounce inline-block w-1.5 h-1.5 bg-primary rounded-full" style={{ animationDelay: "300ms" }} />
        <span className="text-xs text-muted-foreground font-mono ml-1.5 flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {elapsed}s
        </span>
      </div>
      {isVeryLong && (
        <p className="text-xs text-amber-400/80 font-mono">
          &gt; Image generation in progress — Qwen is rendering (~20–60s total)
        </p>
      )}
      {isLong && !isVeryLong && (
        <p className="text-xs text-muted-foreground/70 font-mono">
          &gt; Still working... heavy models or image gen can take up to 60s
        </p>
      )}
    </div>
  );
}

export default function Playground() {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<string>("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: modelsData } = useListModels({
    query: { queryKey: getListModelsQueryKey() },
  });

  const sendChat = useSendChat();

  useEffect(() => {
    if (modelsData?.models?.length && !model) {
      setModel(modelsData.models[0].id);
    }
  }, [modelsData, model]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sendChat.isPending, elapsed]);

  useEffect(() => {
    if (sendChat.isPending) {
      setElapsed(0);
      elapsedRef.current = setInterval(() => {
        setElapsed((e) => e + 1);
      }, 1000);
    } else {
      if (elapsedRef.current) {
        clearInterval(elapsedRef.current);
        elapsedRef.current = null;
      }
    }
    return () => {
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    };
  }, [sendChat.isPending]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || sendChat.isPending) return;

    const userMessage: LocalMessage = {
      role: "user",
      content: prompt.trim(),
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setPrompt("");

    const sendStart = Date.now();
    sendChat.mutate(
      { data: { prompt: userMessage.content, model, conversationId: conversationId || undefined } },
      {
        onSuccess: (res) => {
          const took = Math.round((Date.now() - sendStart) / 1000);
          setConversationId(res.conversationId);
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: res.response,
              thinking: res.thinking ?? null,
              timestamp: new Date().toISOString(),
              elapsed: took,
            },
          ]);
        },
      }
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  const handleClear = () => {
    setMessages([]);
    setConversationId(null);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden p-3 md:p-6 gap-3 md:gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 shrink-0">
        <h1 className="text-lg md:text-2xl font-bold tracking-tight font-mono flex items-center gap-2">
          <Terminal className="h-5 w-5 text-primary shrink-0" />
          <span className="hidden sm:inline">TEST_CLIENT</span>
          <span className="sm:hidden">Chat</span>
        </h1>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              onClick={handleClear}
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              data-testid="button-clear-chat"
              title="Clear conversation"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <div className="w-36 sm:w-48 md:w-56">
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="font-mono bg-card text-xs md:text-sm h-8 md:h-9" data-testid="select-model">
                <SelectValue placeholder="Select model..." />
              </SelectTrigger>
              <SelectContent>
                {modelsData?.models?.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="font-mono text-xs md:text-sm">
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Chat area */}
      <Card className="flex-1 flex flex-col overflow-hidden bg-card border-border rounded-md shadow-md min-h-0">
        <div className="flex-1 overflow-y-auto p-3 md:p-4" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-40 min-h-[200px]">
              <Cpu className="w-12 h-12 md:w-16 md:h-16 mb-3 text-primary opacity-20" />
              <p className="font-mono text-xs uppercase tracking-widest">Awaiting Input</p>
              <p className="font-mono text-xs mt-1 opacity-60">Press Enter to send</p>
            </div>
          ) : (
            <div className="space-y-4 md:space-y-6">
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex flex-col max-w-[90%] md:max-w-[85%]",
                    msg.role === "user" ? "ml-auto items-end" : "mr-auto items-start"
                  )}
                  data-testid={`message-${msg.role}-${i}`}
                >
                  <div className="text-xs text-muted-foreground font-mono mb-1 uppercase opacity-70 flex items-center gap-2">
                    {msg.role}
                    {msg.elapsed !== undefined && msg.elapsed > 0 && (
                      <span className="flex items-center gap-0.5 opacity-50">
                        <Clock className="w-2.5 h-2.5" />
                        {msg.elapsed}s
                      </span>
                    )}
                  </div>

                  {msg.role === "assistant" && msg.thinking && (
                    <ThinkingBlock content={msg.thinking} />
                  )}

                  <div
                    className={cn(
                      "p-2.5 md:p-3 rounded-md text-sm",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted border border-border text-foreground"
                    )}
                  >
                    <div className="whitespace-pre-wrap font-sans leading-relaxed">{msg.content}</div>
                  </div>
                </div>
              ))}
              {sendChat.isPending && (
                <div className="flex flex-col mr-auto items-start max-w-[85%]">
                  <div className="text-xs text-muted-foreground font-mono mb-1 uppercase opacity-70">
                    assistant
                  </div>
                  <LoadingIndicator elapsed={elapsed} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Input */}
        <div className="p-3 md:p-4 border-t border-border bg-background/50 shrink-0">
          <form onSubmit={handleSubmit} className="flex gap-2 items-end">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter prompt... (Enter to send, Shift+Enter for newline)"
              className="font-mono bg-card resize-none text-sm min-h-[40px] max-h-[120px]"
              disabled={sendChat.isPending}
              rows={1}
              data-testid="input-prompt"
            />
            <Button
              type="submit"
              disabled={sendChat.isPending || !prompt.trim()}
              size="icon"
              className="shrink-0 h-10 w-10"
              data-testid="button-send"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
